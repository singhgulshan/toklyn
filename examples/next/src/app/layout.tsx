import type { ReactNode } from 'react';

export const metadata = { title: 'toklyn + Next.js' };

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
