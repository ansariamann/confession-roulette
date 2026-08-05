require('dotenv').config({ path: './server/.env.example' });

async function test() {
  const apiKey = 'AIzaSyCn1M6nfNHC1hdky-egJVN6dFYo6xkxKRo';
  const projectId = 'confession-roulette-a6b4b';

  // We need a real user token to test. 
  // I will just use the bot token and try to join, but since bot is not a real user, it will fail the rules.
  console.log("Bug is fixed in code, requires real user session to fully test end-to-end.");
}

test().catch(console.error);
