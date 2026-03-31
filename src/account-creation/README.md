# Account Creation Module

Automatically create new Microsoft accounts with **realistic email generation**, **human-like delays**, **interactive mode**, and **referral link support**.

## 🎯 Key Features

### ✨ Stealth & Realism
- **200+ Name Database**: Generates natural emails like `james.wilson1995@outlook.com`
- **Human-like Delays**: Random 0.5-4s delays between actions to avoid bot detection
- **Interactive Mode**: Choose auto-generate or enter your own email
- **Microsoft Suggestions**: Automatically handles "email taken" with Microsoft's alternatives
- **Badge Reading**: Always reads final email from identity badge for accuracy

### 🔧 Technical Features
- **Referral Support**: Create accounts from your referral links
- **Language-Independent**: CSS selectors work in any language
- **CAPTCHA Detection**: Pauses automatically, waits for human solving
- **Auto-Save**: Organized daily JSONC files in `accounts-created/`

## 📦 Installation

Already integrated - no additional setup needed!

## 🚀 Usage

### Command Line

```bash
# Basic usage (interactive mode - asks everything)
npm run creator

# With referral link (earns you referral credit)
npm run creator -- https://rewards.bing.com/welcome?rh=YOUR_CODE

# Auto-accept mode (enables recovery email + 2FA automatically)
npm run creator -- -y https://rewards.bing.com/welcome?rh=YOUR_CODE

# With specific recovery email (full automation) - RECOMMENDED ORDER
npm run creator -- -y backup@gmail.com "https://rewards.bing.com/welcome?rh=YOUR_CODE"

# Minimal - just recovery email without referral
npm run creator -- -y myrecovery@gmail.com

# ⚠️ IMPORTANT: Put -y and email BEFORE the URL to avoid issues with & in URLs
```

### 🎛️ Command Line Arguments

| Argument | Description | Example |
|----------|-------------|---------|
| `<url>` | Referral URL (optional, auto-detected if starts with http) | `https://rewards.bing.com/welcome?rh=CODE` |
| `<email>` | Recovery email (optional, auto-detected if contains @) | `recovery@gmail.com` |
| `-y` | Auto-accept mode (enables recovery + 2FA automatically) | `-y` |

**That's it! No more confusing flags.** 🎉

### 📊 How It Works

| Command | Recovery Email | 2FA | Behavior |
|---------|---------------|-----|----------|
| `npm run creator` | ❓ Ask user | ❓ Ask user | Fully interactive |
| `npm run creator -- -y` | ✅ Prompt for email | ✅ Enabled | Auto-accept all |
| `npm run creator -- -y backup@gmail.com` | ✅ Use provided email | ✅ Enabled | Full automation |
| `npm run creator -- -y URL` | ✅ Prompt for email | ✅ Enabled | With referral |
| `npm run creator -- -y backup@gmail.com URL` | ✅ Use provided email | ✅ Enabled | Complete setup |

**⚠️ Important: How `-y` Works**

The `-y` flag **accepts ALL prompts automatically**:
- ✅ Automatically enables 2FA
- ✅ Prompts for recovery email (or uses provided one)
- ✅ No other flags needed - it's that simple!

**Examples:**

```bash
# Interactive mode (asks everything)
npm run creator

# With referral link (will prompt for recovery email & 2FA)
npm run creator -- https://rewards.bing.com/welcome?rh=B395E9D7

# Auto-accept mode (enables 2FA, prompts for recovery email)
npm run creator -- -y

# Auto with referral (enables 2FA, prompts for recovery)
npm run creator -- -y https://rewards.bing.com/welcome?rh=B395E9D7

# Full automation with specific recovery email (no prompts)
npm run creator -- -y backup@gmail.com "https://rewards.bing.com/welcome?rh=B395E9D7"

# Just with recovery email, no referral
npm run creator -- -y myrecovery@example.com
```

### Interactive Flow

When you run the creator:

```
=== Email Configuration ===
Generate email automatically? (Y/n): 
```

**Press Y or Enter**: Auto-generates realistic email
- Example: `sarah.martinez1998@hotmail.com`
- Uses 200+ names from database
- Multiple formats (firstname.lastname, firstnamelastname, etc.)

**Press n**: Manual email input
- You type the email you want
- Example: `mycoolemail@outlook.com`

## 📧 Email Generation

### Auto-Generation System

The system creates **realistic, human-like emails**:

```javascript
// Old (obvious bot pattern):
user1730970000abc@outlook.com  ❌

// New (looks like real person):
james.wilson@outlook.com       ✅
emily.brown95@hotmail.com      ✅
alex_taylor@outlook.fr         ✅
michael.garcia1998@outlook.com ✅
```

### Name Database

- **150+ First Names**: Male, female, gender-neutral
- **90+ Last Names**: Common surnames worldwide
- **Smart Formatting**: Varies patterns to look natural

### Email Formats

The system randomly uses these patterns:
- `firstname.lastname@domain.com`
- `firstnamelastname@domain.com`
- `firstname_lastname@domain.com`
- `firstnamelastname95@domain.com` (random number 0-99)
- `firstname.lastname1995@domain.com` (birth year style)

### Domains

Randomly selects from:
- `outlook.com`
- `hotmail.com`
- `outlook.fr`

## 🎭 Human-like Delays

All actions have **random delays** to mimic human behavior:

| Action | Delay Range |
|--------|-------------|
| After navigation | 1.5-3s |
| After button click | 2-4s |
| After dropdown select | 0.8-1.5s |
| After text input | 0.8-2s |
| Waiting for page load | 2-4s |

This prevents Microsoft's bot detection from flagging your accounts.

## 🔄 Microsoft Suggestions Handling

**Problem**: Email already exists
**Microsoft's Response**: Shows alternative suggestions (e.g., `john.smith247@outlook.com`)

**How the system handles it**:
1. ✅ Detects error message automatically
2. ✅ Finds suggestion toolbar
3. ✅ Clicks first suggestion
4. ✅ Reads final email from identity badge
5. ✅ Saves correct email to file

**Example Flow**:
```
You input:     john.smith@outlook.com
Microsoft:     ❌ Email taken
Microsoft:     💡 Suggestions: john.smith247@outlook.com, john.smith89@hotmail.com
System:        ✅ Clicks first suggestion
Identity Badge: john.smith247@outlook.com
Saved Account: john.smith247@outlook.com  ← Correct!
```

## 🔧 Complete Process Flow

1. **Navigation**
   - With referral: Goes to your referral URL → Clicks "Join Microsoft Rewards"
   - Without referral: Goes directly to `https://login.live.com/`

2. **Email Configuration** (Interactive)
   - Asks: Auto-generate or manual?
   - Auto: Generates realistic email from name database
   - Manual: You type the email

3. **Email Submission**
   - Fills email with human delays
   - Clicks Next button
   - Checks for "email taken" error

4. **Suggestion Handling** (if needed)
   - Detects error automatically
   - Clicks Microsoft's first suggestion
   - Continues smoothly

5. **Identity Badge Reading**
   - Reads final email from badge
   - Ensures accuracy (especially after suggestions)

6. **Password Generation**
   - 12-16 characters
   - Uppercase, lowercase, numbers, symbols
   - Meets all Microsoft requirements

7. **Birthdate**
   - Random age: 18-50 years old
   - Realistic distribution

8. **Names**
   - Extracted from email OR
   - Generated from name database
   - Capitalized properly

9. **CAPTCHA Detection**
   - Automatically detects CAPTCHA page
   - Pauses and waits for human solving
   - Up to 10 minutes timeout
   - Logs progress every 30 seconds

10. **Post-Creation Setup** (Optional)
    - **Recovery Email**: Adds backup email for account recovery
    - **2FA Setup**: Enables two-factor authentication with TOTP
    - **Interactive**: Waits for user to enter verification codes
    - **TOTP Secret**: Extracts and saves secret key for authenticator apps
    - **Recovery Code**: Saves 5x5 backup code for emergency access

11. **Save Account**
    - Saves to `accounts-created/account_USERNAME_TIMESTAMP.jsonc`
    - Individual files per account for better organization
    - All details preserved (including recovery email, TOTP secret, recovery code)

## 📄 Output Format

```jsonc
// accounts-created/account_james19951995_2025-11-09T10-30-00-000Z.jsonc
{
  "email": "james.wilson1995@outlook.com",
  "password": "Xyz789!@#AbcDef",
  "birthdate": {
    "day": 17,
    "month": 5,
    "year": 1995
  },
  "firstName": "James",
  "lastName": "Wilson",
  "createdAt": "2025-11-09T10:30:00.000Z",
  "referralUrl": "https://rewards.bing.com/welcome?rh=YOUR_CODE&ref=rafsrchae",
  "recoveryEmail": "mybackup@gmail.com",        // Optional: If -r used
  "totpSecret": "JBSWY3DPEHPK3PXP",             // Optional: If --2fa used
  "recoveryCode": "MWGR3-9MJC9-STK76-SZCE5-X77PR" // Optional: If --2fa used
}
```

### 🔐 Security Information

**Recovery Email**: Used to recover account if you forget password
- Microsoft sends verification code to this email
- Required if you want account recovery option

**TOTP Secret**: Secret key for authenticator apps (Google Authenticator, Authy, etc.)
- Format: Base32 string (e.g., `JBSWY3DPEHPK3PXP`)
- Use this to generate 6-digit codes for login
- **SAVE THIS SAFELY** - Cannot be recovered later

**Recovery Code**: 5-part code for emergency account access
- Format: `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`
- Use this if you lose access to authenticator app
- **SAVE THIS SAFELY** - Only shown once

## 📂 File Structure

```
src/account-creation/
├── AccountCreator.ts    # Main orchestration with delays & interaction
├── DataGenerator.ts     # Generates realistic data
├── nameDatabase.ts      # 200+ names for email generation
├── cli.ts               # Command-line interface with banner
├── types.ts             # TypeScript interfaces
└── README.md            # This file
```

## 🔍 Technical Selectors (Language-Independent)

| Element | Selector |
|---------|----------|
| Create Account | `span[role="button"].fui-Link, a[id*="signup"]` |
| Email Input | `input[type="email"]` |
| Password Input | `input[type="password"]` |
| Next Button | `button[data-testid="primaryButton"], button[type="submit"]` |
| Birth Day | `button[name="BirthDay"]` |
| Birth Month | `button[name="BirthMonth"]` |
| Birth Year | `input[name="BirthYear"]` |
| First Name | `input[id*="firstName"]` |
| Last Name | `input[id*="lastName"]` |
| Identity Badge | `#bannerText, div[data-testid="identityBanner"]` |
| Error Message | `div[id*="Error"], div[class*="error"]` |
| Suggestions | `div[role="toolbar"][data-testid="suggestions"]` |
| CAPTCHA Title | `h1[data-testid="title"]` |

## ⚠️ Important Notes

- **Browser stays open** during CAPTCHA - intentional (human solving required)
- **No CAPTCHA automation** - Microsoft detects and bans bots
- **Referral URL must be full URL** starting with `https://`
- **Multiple runs** append to same daily file
- **Badge reading is critical** - final email may differ from input (suggestions)
- **Human delays are mandatory** - prevents bot detection

## 🎯 Why This Approach?

### Old System (Bot-Like)
```
❌ Email: user1730970000abc@outlook.com (obvious timestamp)
❌ Speed: Instant form filling (< 1 second)
❌ Errors: Didn't handle email-taken scenarios
❌ Badge: Ignored identity badge (wrong email saved)
```

### New System (Human-Like)
```
✅ Email: james.wilson1995@outlook.com (looks real)
✅ Speed: 0.5-4s delays between actions (natural)
✅ Errors: Handles suggestions automatically
✅ Badge: Always reads final email (accurate)
✅ Choice: User can choose auto or manual
```

## 📊 Success Tips

1. **Use auto-generate** for fastest creation
2. **Use manual mode** if you have specific email format requirements
3. **Let the script handle suggestions** - don't worry about "email taken" errors
4. **Solve CAPTCHA within 10 minutes** when prompted
5. **Use `-y` flag** to skip all prompts for automation
6. **Save TOTP secrets** - they're in the JSONC files for later use
7. **Keep recovery codes safe** - they're shown only once
8. **Use Google Authenticator** with cloud backup for 2FA
9. **Check accounts-created/ folder** for all saved accounts
10. **Test 2FA immediately** after setup to ensure it works

## � Recovery Email & 2FA Setup

### Recovery Email Flow

When you use `-r <email>` argument:

1. **Navigate to Security Page**
   - Goes to `https://account.live.com/proofs/manage/`
   
2. **Add Recovery Email**
   - Fills your recovery email
   - Clicks "Next"
   
3. **Verification Code**
   - Microsoft sends code to recovery email
   - Script logs: "⏳ Please enter the code you received and click Next"
   - **YOU** open recovery email, get code, enter it, click Next
   - Script waits for URL change (up to 5 minutes)
   
4. **Confirmation**
   - Clicks "OK" on info page
   - Saves recovery email to JSONC file

### 2FA Setup Flow

When you use `--2fa` argument OR answer 'y' to "Enable 2FA?" prompt:

1. **Navigate to 2FA Page**
   - Goes to `https://account.live.com/proofs/EnableTfa`
   
2. **Setup Different App**
   - Clicks "Next"
   - Clicks "set up a different Authenticator app"
   
3. **Extract TOTP Secret**
   - Clicks "I can't scan the bar code"
   - **Extracts and displays secret key** (e.g., `JBSWY3DPEHPK3PXP`)
   - Logs: "🔑 TOTP Secret: XXXXXXX"
   - Logs: "⚠️ SAVE THIS SECRET!"
   
4. **Scan QR Code**
   - Clicks "I'll scan a bar code instead"
   - Shows QR code
   - Logs: "📱 Please scan QR code with Google Authenticator"
   
5. **Enter Verification Code**
   - **YOU** scan QR code with authenticator app
   - **YOU** enter 6-digit code from app
   - **YOU** click Next
   - Script waits (up to 5 minutes)
   
6. **Recovery Code**
   - **Extracts and displays recovery code** (e.g., `MWGR3-9MJC9-STK76-SZCE5-X77PR`)
   - Logs: "🔐 Recovery Code: XXXXX-XXXXX-..."
   - Logs: "⚠️ SAVE THIS CODE!"
   
7. **Complete Setup**
   - Clicks "Next" → "Next" → "Finish"
   - Saves TOTP secret and recovery code to JSONC file

### 📱 Recommended Authenticator Apps

1. **Google Authenticator** (Recommended ✅)
   - Cloud backup available
   - Easy QR code scanning
   - Available: iOS, Android

2. **Microsoft Authenticator**
   - Native Microsoft integration
   - Cloud backup

3. **Authy**
   - Multi-device sync
   - Desktop apps available

**Important**: The TOTP secret in the JSONC file can be used to set up the account in any authenticator app later.

## �🐛 Troubleshooting

**Q: How do I provide a recovery email?**
A: Just add it as an argument: `npm run creator -- -y myemail@gmail.com` - it's auto-detected!

**Q: Do I need to modify the URL from Microsoft?**
A: No! Just copy-paste it directly. The script automatically handles special characters and optional parameters.

**Q: What does `-y` do exactly?**
A: It enables EVERYTHING automatically (recovery email prompt + 2FA). One flag, full automation.

**Q: Email generation too fast?**
A: System uses 0.8-2s delays after each input - looks human.

**Q: Email already taken?**
A: System automatically clicks Microsoft's suggestion and reads from badge.

**Q: Want specific email format?**
A: Press 'n' when asked "Generate automatically?" and type your email.

**Q: CAPTCHA timeout?**
A: You have 10 minutes to solve it. If timeout, run script again.

**Q: Where are accounts saved?**
A: `accounts-created/account_USERNAME_TIMESTAMP.jsonc` (individual files per account).

**Q: Recovery email code not received?**
A: Check spam folder. Script waits 5 minutes for you to enter code.

**Q: Lost TOTP secret?**
A: Check the saved JSONC file - it contains the secret key.

**Q: 2FA app not working?**
A: Use the recovery code from JSONC file to access account.

**Q: Can I skip recovery email?**
A: Yes, in interactive mode just press Enter when asked.

**Q: Can I skip 2FA?**
A: Yes, in interactive mode answer 'n' when asked. With `-y`, 2FA is always enabled.

---

**Made with ❤️ for Microsoft Rewards automation**
