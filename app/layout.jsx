import "../src/index.css";
import Providers from "./Providers";
import ClientShell from "./ClientShell";

export const metadata = {
  title: "Confession Roulette",
  description: "Ephemeral anonymous confessions.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <ClientShell>
            {children}
          </ClientShell>
        </Providers>
      </body>
    </html>
  );
}
