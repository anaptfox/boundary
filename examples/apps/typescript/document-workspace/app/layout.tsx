import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "Folio — the document room", description: "An application-owned document workspace, connected by Boundary." };

export default function Layout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
