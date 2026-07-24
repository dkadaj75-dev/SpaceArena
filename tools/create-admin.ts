/**
 * Create (or update) an admin account.
 *
 *   npx tsx tools/create-admin.ts <email> <password> [displayName]
 *
 * Idempotent: an existing user with that email is promoted to role 'admin'
 * and gets the new password; a new user is created and seeded like a normal
 * registration. Uses the same DB/migrations path as the server
 * (SPACE_ARENA_DB env respected).
 */
import { randomUUID } from "node:crypto";
import { getDb, openDatabase, setDb } from "../server/src/db/index.js";
import { usersRepo } from "../server/src/db/repos.js";
import { hashPassword } from "../server/src/auth/password.js";
import { seedNewUser } from "../server/src/db/seed.js";
import { loadContent } from "../server/src/configService.js";

async function main(): Promise<void> {
  const [email, password, displayName = "Admin"] = process.argv.slice(2);
  if (!email || !password) {
    console.error("usage: npx tsx tools/create-admin.ts <email> <password> [displayName]");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("password must be at least 8 characters");
    process.exit(1);
  }

  const configs = await loadContent();
  setDb(openDatabase());
  const passHash = await hashPassword(password);

  const existing = usersRepo.byEmail(email);
  if (existing) {
    getDb()
      .prepare("UPDATE users SET pass_hash = ?, role = 'admin', guest_token = NULL WHERE id = ?")
      .run(passHash, existing.id);
    console.log(`updated existing user ${email} → role=admin, password reset`);
    return;
  }

  const id = randomUUID();
  usersRepo.create({ id, email, pass_hash: passHash, guest_token: null });
  getDb().prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(id);
  seedNewUser(configs, id, displayName); // creates profile + starter modules + default fittings
  console.log(`created admin ${email} (id ${id})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
