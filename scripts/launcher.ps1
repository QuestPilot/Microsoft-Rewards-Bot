param(
    [ValidateSet('menu', 'reinstall', 'uninstall', 'autostart-on', 'autostart-off')]
    [string]$Mode = 'menu'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Dynamic path resolution
$installRoot = if ($env:ProgramData) { Join-Path $env:ProgramData 'Msn-Bot' } else { 'C:\ProgramData\Msn-Bot' }
$projectDir = Join-Path $installRoot 'Microsoft-Rewards-Bot'

$userProfile = if ($env:USERPROFILE) { $env:USERPROFILE } else { [System.Environment]::GetFolderPath('UserProfile') }
$desktop = Join-Path $userProfile 'Desktop'
$desktopShortcut = Join-Path $desktop 'Microsoft Bot.lnk'
$legacyDesktopShortcut = Join-Path $desktop 'MSN Bot.lnk'

$appdata = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $userProfile 'AppData\Roaming' }
$startMenuShortcutDir = Join-Path $appdata 'Microsoft\Windows\Start Menu\Programs\Microsoft Bot'
$startMenuShortcut = Join-Path $startMenuShortcutDir 'Microsoft Bot.lnk'
$legacyStartMenuShortcutDir = Join-Path $appdata 'Microsoft\Windows\Start Menu\Programs\MSN Bot'
$legacyStartMenuShortcut = Join-Path $legacyStartMenuShortcutDir 'MSN Bot.lnk'

$launcherScript = Join-Path $installRoot 'launcher.ps1'
$iconFile = Join-Path $installRoot 'logo.ico'
$repoUrl = 'https://github.com/QuestPilot/Microsoft-Rewards-Bot.git'
$zipUrl = 'https://github.com/QuestPilot/Microsoft-Rewards-Bot/archive/refs/heads/main.zip'
$autoStartTaskName = 'Microsoft Rewards Bot Core Agent'
$reinstallStateDir = Join-Path $env:TEMP 'msn-bot-reinstall'
$reinstallStateFile = Join-Path $reinstallStateDir 'state.json'

function Test-Administrator {
    $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Ensure-Administrator([string]$Action) {
    if (-not (Test-Administrator)) {
        $argumentList = @(
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-File', $PSCommandPath,
            '-Mode', $Action
        )
        Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argumentList
        exit
    }
}

function Invoke-CommandQuiet([string[]]$Command, [string]$WorkingDirectory = $null) {
    $parameters = @{
        FilePath = $Command[0]
        ArgumentList = $Command[1..($Command.Length - 1)]
        Wait = $true
        PassThru = $true
        NoNewWindow = $true
        ErrorAction = 'Stop'
    }
    if ($WorkingDirectory) {
        $parameters.WorkingDirectory = $WorkingDirectory
    }
    $process = Start-Process @parameters
    if ($process.ExitCode -ne 0) {
        throw "Command '$($Command[0])' failed with exit code $($process.ExitCode)."
    }
}

function Invoke-CommandVisible([string[]]$Command, [string]$WorkingDirectory = $null) {
    $parameters = @{
        FilePath = $Command[0]
        ArgumentList = $Command[1..($Command.Length - 1)]
        Wait = $true
        PassThru = $true
        NoNewWindow = $true
        ErrorAction = 'Stop'
    }
    if ($WorkingDirectory) {
        $parameters.WorkingDirectory = $WorkingDirectory
    }
    $process = Start-Process @parameters
    if ($process.ExitCode -ne 0) {
        throw "Command '$($Command[0])' failed with exit code $($process.ExitCode)."
    }
}

function Test-Command([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Open-JsonInNotepad([string]$FileName) {
    $filePath = Join-Path $projectDir ('src' + [IO.Path]::DirectorySeparatorChar + $FileName)
    Start-Process -FilePath 'notepad.exe' -Verb RunAs -ArgumentList @($filePath)
}

function Stop-ProjectProcesses {
    $escapedProjectDir = [Regex]::Escape($projectDir)
    $processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($projectDir, [System.StringComparison]::OrdinalIgnoreCase)) -or
        ($_.CommandLine -and $_.CommandLine -match $escapedProjectDir)
    }

    foreach ($process in $processes) {
        try {
            & taskkill.exe /PID $process.ProcessId /T /F | Out-Null
        } catch {
        }
    }
}

function Get-NpmCommand {
    if (Test-Path 'C:\Program Files\nodejs\npm.cmd') {
        return 'C:\Program Files\nodejs\npm.cmd'
    }
    return 'npm.cmd'
}

function Install-AutoStart {
    if (-not (Test-Path $projectDir)) {
        throw 'Project directory is missing. Install the bot before enabling auto-start.'
    }

    $logsDir = Join-Path $installRoot 'logs'
    New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
    $taskCommand = 'cmd.exe'
    $taskArgs = '/c cd /d "' + $projectDir + '" && npm start -- --background >> "' + (Join-Path $logsDir 'background-agent.log') + '" 2>&1'

    $ErrorActionPreference = 'SilentlyContinue'
    & schtasks.exe /Create /SC ONLOGON /TN $autoStartTaskName /TR ('"' + $taskCommand + '" ' + $taskArgs) /F | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not create the Windows auto-start scheduled task.'
    }
}

function Remove-AutoStart {
    $ErrorActionPreference = 'SilentlyContinue'
    & schtasks.exe /Delete /TN $autoStartTaskName /F 2>$null | Out-Null
}

function Test-AutoStart {
    $ErrorActionPreference = 'SilentlyContinue'
    if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
        return [bool](Get-ScheduledTask -TaskName $autoStartTaskName -ErrorAction SilentlyContinue)
    }
    & schtasks.exe /Query /TN $autoStartTaskName 1>$null 2>$null
    return $LASTEXITCODE -eq 0
}

function Backup-UserFiles {
    $backupRoot = Join-Path $env:TEMP 'msn-bot-backup'
    Remove-Item $backupRoot -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null

    foreach ($fileName in @('accounts.json', 'config.json')) {
        $source = Join-Path $projectDir ('src' + [IO.Path]::DirectorySeparatorChar + $fileName)
        if (Test-Path $source) {
            Copy-Item $source (Join-Path $backupRoot $fileName) -Force
        }
    }

    return $backupRoot
}

function Write-ReinstallState([string]$BackupRoot) {
    New-Item -ItemType Directory -Path $reinstallStateDir -Force | Out-Null
    $state = @{
        backup_root = $BackupRoot
    }
    $state | ConvertTo-Json | Set-Content -Path $reinstallStateFile -Encoding UTF8
}

function Clear-ReinstallState {
    Remove-Item $reinstallStateDir -Recurse -Force -ErrorAction SilentlyContinue
}

function Restore-UserFiles {
    if (-not (Test-Path $reinstallStateFile)) {
        return
    }

    $state = Get-Content $reinstallStateFile -Raw | ConvertFrom-Json
    if (-not $state.backup_root -or -not (Test-Path $state.backup_root)) {
        Clear-ReinstallState
        return
    }

    foreach ($fileName in @('accounts.json', 'config.json')) {
        $backupFile = Join-Path $state.backup_root $fileName
        if (Test-Path $backupFile) {
            Copy-Item $backupFile (Join-Path $projectDir ('src' + [IO.Path]::DirectorySeparatorChar + $fileName)) -Force
        }
    }

    Remove-Item $state.backup_root -Recurse -Force -ErrorAction SilentlyContinue
    Clear-ReinstallState
}

function Remove-ExistingProject {
    if (Test-Path $projectDir) {
        Remove-Item $projectDir -Recurse -Force -ErrorAction Stop
    }
}

function Remove-FolderRobust([string]$Path) {
    if (-not (Test-Path $Path)) { return }
    $ErrorActionPreference = 'SilentlyContinue'
    
    # 1. Kill locks
    Stop-ProjectProcesses
    
    # 2. Basic Remove-Item
    Remove-Item $Path -Recurse -Force 2>$null
    if (-not (Test-Path $Path)) { return }
    
    # 3. Fallback to cmd rmdir
    & cmd.exe /c rmdir /s /q `"$Path`" 2>$null
    if (-not (Test-Path $Path)) { return }
    
    # 4. If still locked, rename it out of conflict range
    $tempPath = Join-Path (Split-Path $Path) ("old-bot-tmp-" + (Get-Random))
    Rename-Item $Path -NewName (Split-Path $tempPath -Leaf) 2>$null
    
    # Clean in background
    if (Test-Path $tempPath) {
        Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden -ArgumentList @('/c', "timeout /t 5 /nobreak & rmdir /s /q `"$tempPath`"")
    }
}

function Install-Project {
    New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
    if (Test-Path $projectDir) {
        Remove-FolderRobust $projectDir
    }

    if (Test-Command 'git') {
        try {
            Invoke-CommandQuiet @('git', 'clone', '-b', 'main', $repoUrl, $projectDir)
            return
        } catch {
            if (Test-Path $projectDir) {
                Remove-FolderRobust $projectDir
            }
        }
    }

    $tempRoot = Join-Path $env:TEMP 'msn-bot-install'
    Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

    $zipPath = Join-Path $tempRoot 'project.zip'
    $extractPath = Join-Path $tempRoot 'extract'
    New-Item -ItemType Directory -Path $extractPath -Force | Out-Null

    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath
    Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force

    $extractedFolder = Get-ChildItem $extractPath -Directory | Select-Object -First 1
    if (-not $extractedFolder) {
        throw 'Downloaded archive did not contain a project folder.'
    }

    Move-Item $extractedFolder.FullName $projectDir
    Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

function Install-Dependencies {
    $npmCommand = Get-NpmCommand
    try {
        Invoke-CommandQuiet @($npmCommand, 'ci', '--no-audit', '--no-fund', '--no-progress') $projectDir
    } catch {
        Invoke-CommandQuiet @($npmCommand, 'install', '--legacy-peer-deps', '--no-audit', '--no-fund', '--no-progress') $projectDir
    }
}

function Create-ApplicationShortcuts {
    New-Item -ItemType Directory -Path $startMenuShortcutDir -Force | Out-Null
    $shell = New-Object -ComObject WScript.Shell

    Remove-ApplicationShortcuts

    $shortcutCmd = '-NoProfile -ExecutionPolicy Bypass -Command "$f=Join-Path $env:TEMP ''launcher.ps1''; iwr ''https://raw.githubusercontent.com/QuestPilot/Microsoft-Rewards-Bot/main/scripts/launcher.ps1'' -OutFile $f -UseBasicParsing; & $f"'

    $shortcut = $shell.CreateShortcut($desktopShortcut)
    $shortcut.TargetPath = 'powershell.exe'
    $shortcut.Arguments = $shortcutCmd
    $shortcut.WorkingDirectory = $projectDir
    $shortcut.IconLocation = '{0},0' -f $iconFile
    $shortcut.Save()

    $startMenu = $shell.CreateShortcut($startMenuShortcut)
    $startMenu.TargetPath = 'powershell.exe'
    $startMenu.Arguments = $shortcutCmd
    $startMenu.WorkingDirectory = $projectDir
    $startMenu.IconLocation = '{0},0' -f $iconFile
    $startMenu.Save()
}

function Remove-ApplicationShortcuts {
    if (Test-Path $desktopShortcut) {
        Remove-Item $desktopShortcut -Force
    }
    if (Test-Path $legacyDesktopShortcut) {
        Remove-Item $legacyDesktopShortcut -Force
    }
    if (Test-Path $startMenuShortcut) {
        Remove-Item $startMenuShortcut -Force
    }
    if (Test-Path $legacyStartMenuShortcut) {
        Remove-Item $legacyStartMenuShortcut -Force
    }
    if (Test-Path $startMenuShortcutDir) {
        Remove-Item $startMenuShortcutDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path $legacyStartMenuShortcutDir) {
        Remove-Item $legacyStartMenuShortcutDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Ensure-StartMenuShortcut {
    $ErrorActionPreference = 'SilentlyContinue'
    if (-not (Test-Path $startMenuShortcut)) {
        New-Item -ItemType Directory -Path $startMenuShortcutDir -Force | Out-Null
        $shell = New-Object -ComObject WScript.Shell
        
        $shortcutCmd = '-NoProfile -ExecutionPolicy Bypass -Command "$f=Join-Path $env:TEMP ''launcher.ps1''; iwr ''https://raw.githubusercontent.com/QuestPilot/Microsoft-Rewards-Bot/main/scripts/launcher.ps1'' -OutFile $f -UseBasicParsing; & $f"'
        
        $startMenu = $shell.CreateShortcut($startMenuShortcut)
        $startMenu.TargetPath = 'powershell.exe'
        $startMenu.Arguments = $shortcutCmd
        $startMenu.WorkingDirectory = $projectDir
        $startMenu.IconLocation = '{0},0' -f $iconFile
        $startMenu.Save()
    }
}

# --- Beautiful Console Graphics & Fast Status Caching ---

function Initialize-Status {
    $global:botInstalled = Test-Path (Join-Path $projectDir 'package.json')
    $global:autoStartStatus = if (Test-AutoStart) { 'Enabled' } else { 'Disabled' }

    $global:nodeVersion = 'Not Found'
    if (Test-Command 'node') {
        try {
            $global:nodeVersion = (node --version).Trim().TrimStart('v')
        } catch {}
    }

    $global:gitInstalled = 'No'
    if (Test-Command 'git') {
        $global:gitInstalled = 'Yes'
    }
}

function Show-LoadingAnimation([string]$Message) {
    $frames = @('⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏')
    Write-Host -NoNewline "  "
    for ($i = 0; $i -lt 12; $i++) {
        $frame = $frames[$i % $frames.Length]
        Write-Host -NoNewline "`r  $frame $Message..." -ForegroundColor Cyan
        Start-Sleep -Milliseconds 30
    }
    Write-Host "`r" -NoNewline
}

function Change-MenuState([string]$NewState) {
    Show-LoadingAnimation 'Loading'
    $global:menuState = $NewState
}

function Show-Header([string]$Title, [string]$Subtitle = '') {
    Clear-Host
    Write-Host '  ┌──────────────────────────────────────────────────┐' -ForegroundColor Cyan
    Write-Host ('  │ ' + $Title.PadRight(48) + ' │') -ForegroundColor Cyan
    if ($Subtitle) {
        Write-Host ('  │ ' + $Subtitle.PadRight(48) + ' │') -ForegroundColor Gray
    }
    Write-Host '  ├──────────────────────────────────────────────────┤' -ForegroundColor Cyan
    
    # Render Status
    $statusStr = if ($global:botInstalled) { 'Installed' } else { 'Not Installed' }
    $statusColor = if ($global:botInstalled) { 'Green' } else { 'Red' }
    $autoStartColor = if ($global:autoStartStatus -eq 'Enabled') { 'Green' } else { 'Gray' }
    
    $statusPart = "Status: $statusStr"
    $autoStartPart = "Auto-Start: $global:autoStartStatus"
    
    Write-Host '  │ ' -NoNewline -ForegroundColor Cyan
    Write-Host $statusPart.PadRight(23) -NoNewline -ForegroundColor $statusColor
    Write-Host '│ ' -NoNewline -ForegroundColor Cyan
    Write-Host $autoStartPart.PadRight(23) -NoNewline -ForegroundColor $autoStartColor
    Write-Host ' │' -ForegroundColor Cyan
    
    # Render Node/Git Info
    $nodePart = "Node: v$global:nodeVersion"
    $gitPart = "Git: $global:gitInstalled"
    
    Write-Host '  │ ' -NoNewline -ForegroundColor Cyan
    Write-Host $nodePart.PadRight(23) -NoNewline -ForegroundColor Gray
    Write-Host '│ ' -NoNewline -ForegroundColor Cyan
    Write-Host $gitPart.PadRight(23) -NoNewline -ForegroundColor Gray
    Write-Host ' │' -ForegroundColor Cyan
    
    Write-Host '  └──────────────────────────────────────────────────┘' -ForegroundColor Cyan
    Write-Host ''
}

function Show-Menu {
    $descriptions_main = @(
        'Launch the bot in an interactive command window to watch it work.',
        'Run the bot silently in the background (sends metrics to dashboard).',
        'Display the latest lines of the background agent log file.',
        'Open accounts.json in Notepad to add or edit your Microsoft accounts.',
        'Open config.json in Notepad to customize delays, settings, and thresholds.',
        'Open the maintenance submenu (Auto-start, Build, Reinstall, Uninstall).',
        'Close this launcher window.'
    )

    $descriptions_tools = @(
        'Toggle whether the bot starts automatically when you log into Windows.',
        'Compile the TypeScript/bundle files of the local project.',
        'Backup configuration, download the latest main code, and reinstall.',
        'Delete all bot files, shortcuts, tasks, and configurations.',
        'Return to the main launcher menu.'
    )

    $index = 0
    while ($true) {
        $items = @()
        $descriptions = @()
        if ($global:menuState -eq 'main') {
            $items = @(
                'Start Bot (Interactive)',
                'Start Background Agent (Silent)',
                'View Background Agent Logs',
                'Edit Accounts (accounts.json)',
                'Edit Settings (config.json)',
                'Maintenance & Tools...',
                'Exit'
            )
            $descriptions = $descriptions_main
        } else {
            $autoStartLabel = if ($global:autoStartStatus -eq 'Enabled') { 'Enabled' } else { 'Disabled' }
            $items = @(
                "Toggle Windows Auto-Start [Currently: $autoStartLabel]",
                'Build Project',
                'Reinstall / Update Bot (Keeps config)',
                'Uninstall Everything',
                '<-- Back to Main Menu'
            )
            $descriptions = $descriptions_tools
        }

        # Safe boundaries when switching menu states
        if ($index -ge $items.Length) {
            $index = 0
        }

        $titleLabel = if ($global:menuState -eq 'main') { 'Main Menu' } else { 'Maintenance & Tools' }
        Show-Header 'MICROSOFT BOT - LAUNCHER' ("Mode: $titleLabel")
        
        Write-Host '  Project Directory:' -ForegroundColor DarkGray
        Write-Host ("  " + $projectDir) -ForegroundColor White
        Write-Host ''
        
        for ($i = 0; $i -lt $items.Length; $i++) {
            $selected = $i -eq $index
            $num = ($i + 1).ToString().PadLeft(2)
            if ($selected) {
                Write-Host ("  > [{0}] {1}" -f $num, $items[$i]) -ForegroundColor Cyan
            } else {
                Write-Host ("    [{0}] {1}" -f $num, $items[$i]) -ForegroundColor Gray
            }
        }
        Write-Host ''
        Write-Host '  ──────────────────────────────────────────────────' -ForegroundColor DarkGray
        Write-Host ("  Info: " + $descriptions[$index]) -ForegroundColor Gray
        Write-Host '  ──────────────────────────────────────────────────' -ForegroundColor DarkGray
        Write-Host '  [▲/▼] Move  │  [Enter] Select  │  [Esc] Exit' -ForegroundColor DarkGray

        $key = [Console]::ReadKey($true).Key
        if ($key -eq 'UpArrow' -and $index -gt 0) {
            $index--
        } elseif ($key -eq 'DownArrow' -and $index -lt ($items.Length - 1)) {
            $index++
        } elseif ($key -eq 'Enter') {
            return $index
        } elseif ($key -eq 'Escape') {
            if ($global:menuState -eq 'tools') {
                Change-MenuState 'main'
                $index = 5  # Focus back on "Maintenance & Tools..."
            } else {
                return $items.Length - 1 # Main menu exit option
            }
        }
    }
}

# --- Action Implementations ---

function Start-Bot {
    Show-Header 'STARTING THE BOT' 'Running npm run start from the installed project.'
    Invoke-CommandVisible @('cmd.exe', '/c', 'npm run start') $projectDir
    Write-Host "`n  Program finished."
    Read-Host '  Press Enter to continue'
}

function Start-BackgroundAgent {
    Show-Header 'STARTING BACKGROUND AGENT' 'Running npm start -- --background from the installed project.'
    Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', 'npm start -- --background') -WorkingDirectory $projectDir -WindowStyle Hidden
    Write-Host "`n  Background agent started. Use the dashboard or npm start -- --attach to inspect it."
    Read-Host '  Press Enter to continue'
}

function Show-Logs {
    $logPath = Join-Path $installRoot 'logs\background-agent.log'
    while ($true) {
        Show-Header 'BACKGROUND AGENT LOGS' 'Press [R] to Refresh | [O] to Open in Notepad | [Esc] to Return'
        
        if (Test-Path $logPath) {
            Write-Host "  Last 25 log lines:" -ForegroundColor Gray
            Write-Host "  ──────────────────────────────────────────────────" -ForegroundColor DarkGray
            Get-Content $logPath -Tail 25 | ForEach-Object {
                Write-Host ("  " + $_) -ForegroundColor White
            }
            Write-Host "  ──────────────────────────────────────────────────" -ForegroundColor DarkGray
        } else {
            Write-Host "  No log file found yet at: $logPath" -ForegroundColor Yellow
        }
        Write-Host ""
        Write-Host "  [R] Refresh  │  [O] Open Notepad  │  [Any other key] Return" -ForegroundColor DarkGray
        
        $key = [Console]::ReadKey($true).Key
        if ($key -eq 'O') {
            Start-Process 'notepad.exe' -ArgumentList $logPath
        } elseif ($key -eq 'R') {
            continue
        } else {
            break
        }
    }
}

function Toggle-AutoStart {
    if ($global:autoStartStatus -eq 'Enabled') {
        Disable-AutoStart
    } else {
        Enable-AutoStart
    }
}

function Enable-AutoStart {
    Ensure-Administrator 'autostart-on'
    Show-Header 'ENABLING AUTO-START' 'Creating the Windows scheduled task.'
    Install-AutoStart
    Initialize-Status
    Write-Host "`n  [OK] Auto-start enabled."
    Read-Host '  Press Enter to continue'
}

function Disable-AutoStart {
    Ensure-Administrator 'autostart-off'
    Show-Header 'DISABLING AUTO-START' 'Removing the Windows scheduled task.'
    Remove-AutoStart
    Initialize-Status
    Write-Host "`n  [OK] Auto-start disabled."
    Read-Host '  Press Enter to continue'
}

function Build-Project {
    Show-Header 'BUILDING THE PROJECT' 'Running npm run build from the installed project.'
    Invoke-CommandQuiet @('cmd.exe', '/c', 'npm run build') $projectDir
    Write-Host "`n  Build finished."
    Read-Host '  Press Enter to continue'
}

function Edit-Accounts {
    Open-JsonInNotepad 'accounts.json'
}

function Edit-Config {
    Open-JsonInNotepad 'config.json'
}

function Reinstall-Bot {
    Ensure-Administrator 'reinstall'
    Show-Header 'REINSTALLING THE BOT' 'Backing up your JSON files and reinstalling.'

    Write-Host '  [1/8] Backing up configuration files...' -ForegroundColor Gray
    $backupRoot = Backup-UserFiles
    Write-ReinstallState $backupRoot
    Start-Sleep -Milliseconds 300

    Write-Host '  [2/8] Stopping project processes...' -ForegroundColor Gray
    Stop-ProjectProcesses
    Start-Sleep -Milliseconds 300

    Write-Host '  [3/8] Removing application shortcuts...' -ForegroundColor Gray
    Remove-ApplicationShortcuts
    Start-Sleep -Milliseconds 300

    Write-Host '  [4/8] Removing Windows auto-start task...' -ForegroundColor Gray
    Remove-AutoStart
    Start-Sleep -Milliseconds 300

    Write-Host '  [5/8] Cleaning up project folder...' -ForegroundColor Gray
    Remove-FolderRobust $projectDir
    Start-Sleep -Milliseconds 300

    Write-Host '  [6/8] Installing project files...' -ForegroundColor Gray
    Install-Project
    Start-Sleep -Milliseconds 300

    Write-Host '  [7/8] Installing dependencies (npm)...' -ForegroundColor Gray
    Install-Dependencies
    Start-Sleep -Milliseconds 300

    Write-Host '  [8/8] Restoring user configurations...' -ForegroundColor Gray
    Restore-UserFiles
    Create-ApplicationShortcuts
    Initialize-Status
    Start-Sleep -Milliseconds 300

    Write-Host ''
    Write-Host '  [OK] Reinstallation completed successfully!' -ForegroundColor Green
    Write-Host ''
    Read-Host '  Press Enter to continue'
}

function Uninstall-Bot {
    Ensure-Administrator 'uninstall'
    Show-Header 'UNINSTALLING THE BOT' 'This removes all bot files, tasks, and shortcuts.'

    Write-Host '  This will delete the project, launcher, icon and application shortcuts.'
    Write-Host '  Your accounts.json and config.json will be permanently removed.'
    Write-Host ''
    $confirm = Read-Host '  Type YES to confirm uninstall'
    if ($confirm -ne 'YES') {
        Write-Host ''
        Write-Host '  [!] Uninstall cancelled.' -ForegroundColor Yellow
        Write-Host ''
        Read-Host '  Press Enter to return'
        return
    }

    Show-Header 'UNINSTALLING THE BOT' 'Deleting files and cleaning up system.'

    Write-Host '  [-] Stopping project processes...' -ForegroundColor Gray
    Stop-ProjectProcesses
    Start-Sleep -Milliseconds 300

    Write-Host '  [-] Removing shortcuts...' -ForegroundColor Gray
    Remove-ApplicationShortcuts
    Start-Sleep -Milliseconds 300

    Write-Host '  [-] Removing Windows auto-start...' -ForegroundColor Gray
    Remove-AutoStart
    Start-Sleep -Milliseconds 300

    Write-Host '  [-] Deleting project directory...' -ForegroundColor Gray
    Remove-FolderRobust $projectDir
    Start-Sleep -Milliseconds 300

    Write-Host '  [-] Cleaning up leftover files...' -ForegroundColor Gray
    Remove-Item $launcherScript -Force -ErrorAction SilentlyContinue
    Remove-Item $iconFile -Force -ErrorAction SilentlyContinue
    
    Remove-FolderRobust $installRoot
    Clear-ReinstallState
    Start-Sleep -Milliseconds 300

    Write-Host ''
    Write-Host '  [OK] Uninstall completed successfully!' -ForegroundColor Green
    Write-Host ''
    Read-Host '  Press Enter to close launcher'
    exit
}

# --- Entrypoint & Execution Router ---

switch ($Mode) {
    'reinstall' { Reinstall-Bot; exit }
    'uninstall' { Uninstall-Bot; exit }
    'autostart-on' { Enable-AutoStart; exit }
    'autostart-off' { Disable-AutoStart; exit }
}

# Load state cache before starting loop
$global:menuState = 'main'
Initialize-Status
Ensure-StartMenuShortcut

while ($true) {
    $choice = Show-Menu
    if ($global:menuState -eq 'main') {
        switch ($choice) {
            0 { Start-Bot }
            1 { Start-BackgroundAgent }
            2 { Show-Logs }
            3 { Edit-Accounts }
            4 { Edit-Config }
            5 { Change-MenuState 'tools' }
            6 { break }
        }
    } else {
        switch ($choice) {
            0 { Toggle-AutoStart }
            1 { Build-Project }
            2 { Reinstall-Bot }
            3 { Uninstall-Bot }
            4 { Change-MenuState 'main' }
        }
    }
}
