# Small Windows-only helpers for start-desk.cmd (splash positioning + best-effort
# foreground). Kept as its own .ps1 file rather than inlined into the .cmd string —
# a triple-nested batch/PowerShell/C# quoting string is a maintenance trap; a real
# file with real syntax highlighting is not.
#
# Usage:
#   powershell -NoProfile -NonInteractive -File win-window-helper.ps1 center 460 300
#     -> prints "X,Y" for a window of that size centered on the primary screen.
#   powershell -NoProfile -NonInteractive -File win-window-helper.ps1 foreground "Window Title"
#     -> waits briefly, then best-effort brings the first window matching that
#        EXACT title to the foreground. Windows' own focus-stealing prevention can
#        still block this for a background-launched process — this is best-effort,
#        not a guarantee, same as most apps showing a splash/loading window.

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('center', 'foreground')]
    [string]$Action,

    [Parameter(Position = 1)]
    [string]$Arg1,

    [Parameter(Position = 2)]
    [string]$Arg2
)

if ($Action -eq 'center') {
    Add-Type -AssemblyName System.Windows.Forms
    $width = [int]$Arg1
    $height = [int]$Arg2
    $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $x = [int](($area.Width - $width) / 2)
    $y = [int](($area.Height - $height) / 2)
    Write-Output "$x,$y"
    exit 0
}

if ($Action -eq 'foreground') {
    $title = $Arg1
    Start-Sleep -Milliseconds 400
    Add-Type -Name Win32Foreground -Namespace MsrbHelper -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
'@
    $handle = [MsrbHelper.Win32Foreground]::FindWindow($null, $title)
    if ($handle -ne [IntPtr]::Zero) {
        [MsrbHelper.Win32Foreground]::SetForegroundWindow($handle) | Out-Null
    }
    exit 0
}
