import type { ReactNode } from "react";

import "./globals.css";

export const metadata = {
  title: "TypeScript on Rails · Full-stack reference",
  description: "A production-shaped local reference application",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
