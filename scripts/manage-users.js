#!/usr/bin/env node
// Usage:
//   node scripts/manage-users.js add alice@marv.com "some strong password"
//   node scripts/manage-users.js remove alice@marv.com
//   node scripts/manage-users.js list
const users = require('../server/users');

const [, , cmd, email, password] = process.argv;

if (cmd === 'add' && email && password) {
  users.addUser(email, password);
  console.log(`Added/updated user: ${email}`);
} else if (cmd === 'remove' && email) {
  const existed = users.removeUser(email);
  console.log(existed ? `Removed user: ${email}` : `No such user: ${email}`);
} else if (cmd === 'list') {
  console.log(`${users.count()} user(s) configured.`);
} else {
  console.log('Usage:');
  console.log('  node scripts/manage-users.js add <email> <password>');
  console.log('  node scripts/manage-users.js remove <email>');
  console.log('  node scripts/manage-users.js list');
  process.exit(1);
}
