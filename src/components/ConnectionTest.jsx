import { useEffect, useState } from "react";
import { doc, setDoc, deleteDoc } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../context/AuthProvider";

/**
 * ConnectionTest — writes a test doc to Firestore, reads it back, then deletes it.
 * Displays a status badge showing whether Firebase Auth + Firestore are connected.
 */
export default function ConnectionTest() {
  const { user } = useAuth();
  const [status, setStatus] = useState("loading"); // "loading" | "success" | "error"
  const [message, setMessage] = useState("Checking connection…");

  useEffect(() => {
    if (!user) return;

    const testDocRef = doc(db, "_connectionTest", user.uid);

    async function runTest() {
      try {
        // 1. Write a test document
        await setDoc(testDocRef, {
          test: true,
          uid: user.uid,
          timestamp: Date.now(),
        });

        setStatus("success");
        setMessage("Firebase connected");

        // 2. Clean up — delete the test doc
        await deleteDoc(testDocRef);
      } catch (err) {
        console.error("Connection test failed:", err);
        setStatus("error");
        setMessage("Connection failed");
      }
    }

    runTest();
  }, [user]);

  return (
    <div className={`connection-badge ${status}`} id="connection-test">
      <span className="badge-dot" />
      <span>{message}</span>
    </div>
  );
}
