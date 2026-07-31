"use client";

import AuthProvider from "../src/context/AuthProvider";
import DropProvider from "../src/context/DropContext";

export default function Providers({ children }) {
  return (
    <AuthProvider>
      <DropProvider>
        {children}
      </DropProvider>
    </AuthProvider>
  );
}
