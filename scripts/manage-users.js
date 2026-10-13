#!/usr/bin/env node
// Usage:
//   node scripts/manage-users.js add alice@marv.com "some strong password" [admin|viewer]
//   node scripts/manage-users.js role alice@marv.com admin
//   node scripts/manage-users.js reset-2fa alice@marv.com
//   node scripts/manage-users.js remove alice@marv.com
//   node scripts/manage-users.js list
require('dotenv').config();
const users = require('../server/users');
const audit = require('../server/audit');

const [, , cmd, email, arg] = process.argv;
const by = { email: 'manage-users script' };

function usage() {
  console.log('Usage:');
  console.log('  node scripts/manage-users.js add <email> <password> [admin|viewer]   (new users default to viewer)');
  console.log('  node scripts/manage-users.js role <email> <admin|viewer>');
  console.log('  node scripts/manage-users.js reset-2fa <email>   (user sets up 2FA again at next login)');
  console.log('  node scripts/manage-users.js remove <email>');
  console.log('  node scripts/manage-users.js list');
  process.exit(1);
}

try {
  if (cmd === 'add' && email && arg) {
    users.addUser(email, arg, process.argv[5]);
    audit.log('user_added', { ...by, target: email.toLowerCase(), role: users.get(email).role });
    console.log(`Added/updated user: ${email} (${users.get(email).role})`);
  } else if (cmd === 'role' && email && arg) {
    if (!users.setRole(email, arg)) { console.log(`No such user: ${email}`); process.exit(1); }
    audit.log('user_role_changed', { ...by, target: email.toLowerCase(), role: arg });
    console.log(`${email} is now ${arg}`);
  } else if (cmd === 'reset-2fa' && email) {
    if (!users.resetTotp(email)) { console.log(`No such user: ${email}`); process.exit(1); }
    audit.log('user_2fa_reset', { ...by, target: email.toLowerCase() });
    console.log(`2FA reset for ${email}. They'll be asked to set it up again at next login.`);
  } else if (cmd === 'remove' && email) {
    const existed = users.removeUser(email);
    if (existed) audit.log('user_removed', { ...by, target: email.toLowerCase() });
    console.log(existed ? `Removed user: ${email}` : `No such user: ${email}`);
  } else if (cmd === 'list') {
    const all = users.list();
    console.log(`${all.length} user(s) configured.`);
    for (const u of all) console.log(`  ${u.email}  ${u.role}  2FA ${u.totpEnabled ? 'on' : 'not set up'}`);
  } else {
    usage();
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
