export interface CreatedAccount {
  email: string
  password: string
  birthdate: {
    day: number
    month: number
    year: number
  }
  firstName: string
  lastName: string
  createdAt: string
  referralUrl?: string
  recoveryEmail?: string
  totpSecret?: string
  recoveryCode?: string
  notes?: string
}
