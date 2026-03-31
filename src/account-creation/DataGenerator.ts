import {
    secureRandom,
    secureRandomInt,
    secureRandomPick,
} from "../util/security/SecureRandom";
import { getRandomFirstName, getRandomLastName } from "./nameDatabase";

export class DataGenerator {
  generateEmail(customFirstName?: string, customLastName?: string): string {
    const firstName = customFirstName || getRandomFirstName();
    const lastName = customLastName || getRandomLastName();

    const cleanFirst = firstName.toLowerCase().replace(/[^a-z]/g, "");
    const cleanLast = lastName.toLowerCase().replace(/[^a-z]/g, "");

    // IMPROVED: More variations to avoid pattern detection
    const randomNum = secureRandomInt(0, 9998);
    const randomYear = secureRandomInt(1985, 2004);
    const randomShortNum = secureRandomInt(1, 99);
    const firstInitial = cleanFirst.charAt(0);
    const lastInitial = cleanLast.charAt(0);

    // IMPROVED: 20 patterns instead of 8 (harder to detect)
    const patterns = [
      `${cleanFirst}.${cleanLast}`,
      `${cleanFirst}${cleanLast}`,
      `${cleanFirst}_${cleanLast}`,
      `${cleanFirst}.${cleanLast}${randomNum}`,
      `${cleanFirst}${randomNum}`,
      `${cleanLast}${cleanFirst}`,
      `${cleanFirst}.${cleanLast}${randomYear}`,
      `${cleanFirst}${randomYear}`,
      `${firstInitial}${cleanLast}${randomShortNum}`,
      `${cleanFirst}${lastInitial}${randomYear}`,
      `${firstInitial}.${cleanLast}`,
      `${cleanFirst}-${cleanLast}`,
      `${cleanLast}.${cleanFirst}`,
      `${cleanFirst}${randomShortNum}${cleanLast}`,
      `${firstInitial}${lastInitial}${randomNum}`,
      `${cleanLast}${randomYear}`,
      `${cleanFirst}.${randomYear}`,
      `${cleanFirst}_${randomNum}`,
      `${lastInitial}${cleanFirst}${randomShortNum}`,
      `${cleanFirst}${cleanLast}${randomShortNum}`,
    ];

    const username = secureRandomPick(patterns) ?? patterns[0];
    return `${username}@outlook.com`;
  }

  generatePassword(): string {
    const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const lowercase = "abcdefghijklmnopqrstuvwxyz";
    const numbers = "0123456789";
    const symbols = "!@#$%^&*";

    let password = "";

    // Ensure at least one of each required type
    password += uppercase[secureRandomInt(0, uppercase.length - 1)];
    password += lowercase[secureRandomInt(0, lowercase.length - 1)];
    password += numbers[secureRandomInt(0, numbers.length - 1)];
    password += symbols[secureRandomInt(0, symbols.length - 1)];

    // Fill the rest (total length: 14-18 chars for better security)
    const allChars = uppercase + lowercase + numbers + symbols;
    const targetLength = secureRandomInt(14, 18);

    for (let i = password.length; i < targetLength; i++) {
      password += allChars[secureRandomInt(0, allChars.length - 1)];
    }

    // Shuffle to mix required characters
    password = password
      .split("")
      .sort(() => secureRandom() - 0.5)
      .join("");

    return password;
  }

  generateBirthdate(): { day: number; month: number; year: number } {
    const currentYear = new Date().getFullYear();

    // Age between 20 and 45 years old (safer range)
    const minAge = 20;
    const maxAge = 45;

    const age = secureRandomInt(minAge, maxAge);
    const year = currentYear - age;

    const month = secureRandomInt(1, 12);
    const daysInMonth = new Date(year, month, 0).getDate();
    const day = secureRandomInt(1, daysInMonth);

    return { day, month, year };
  }

  generateNames(email: string): { firstName: string; lastName: string } {
    const username = email.split("@")[0] || "user";

    // Split on numbers, dots, underscores, hyphens
    const parts = username.split(/[0-9._-]+/).filter((p) => p.length > 1);

    if (parts.length >= 2) {
      return {
        firstName: this.capitalize(parts[0] || getRandomFirstName()),
        lastName: this.capitalize(parts[1] || getRandomLastName()),
      };
    } else if (parts.length === 1 && parts[0]) {
      return {
        firstName: this.capitalize(parts[0]),
        lastName: getRandomLastName(),
      };
    }

    return {
      firstName: getRandomFirstName(),
      lastName: getRandomLastName(),
    };
  }

  private capitalize(str: string): string {
    if (!str || str.length === 0) return "";
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
  }
}
