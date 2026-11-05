import { randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const readline = createInterface({ input: stdin, output: stdout });
try {
  const password = await readline.question('Admin password (input is visible in this terminal): ');
  if (password.length < 12) {
    console.error('Use a password with at least 12 characters.');
    process.exitCode = 1;
  } else {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, 64).toString('hex');
    console.log(`ADMIN_PASSWORD_HASH=scrypt$${salt}$${hash}`);
  }
} finally {
  readline.close();
}
