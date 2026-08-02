import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import fs from "fs";

const serviceAccount = JSON.parse(fs.readFileSync("./server/serviceAccountKey.json", "utf8"));

initializeApp({
  credential: cert(serviceAccount)
});

async function createBot() {
  try {
    const userRecord = await getAuth().createUser({
      uid: "admin_bot_uid",
      email: "bot@confessionroulette.com",
      password: "super_secret_bot_password",
      displayName: "Moderation Bot",
    });
    console.log("Successfully created new bot user:", userRecord.uid);
  } catch (error) {
    if (error.code === 'auth/uid-already-exists' || error.code === 'auth/email-already-exists') {
      console.log("Bot user already exists.");
    } else {
      console.error("Error creating bot user:", error);
    }
  }
}

createBot();
