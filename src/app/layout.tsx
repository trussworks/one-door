import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "../ui/shell";

import "./globals.css";
import "../ui/app.css";

export const metadata: Metadata = {
  title: "One Door",
  description: "Request software and infrastructure services from OIT.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="usa-skipnav" href="#main-content">
          Skip to main content
        </a>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
