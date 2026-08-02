"use client";

import dynamic from "next/dynamic";

const AuthProvider = dynamic(() => import("../src/context/AuthProvider"), { ssr: false });
const DropProvider = dynamic(() => import("../src/context/DropContext"), { ssr: false });

export default function Providers({ children }) {
  return (
    <AuthProvider>
      <DropProvider>
        {children}
      </DropProvider>
    </AuthProvider>
  );
}
