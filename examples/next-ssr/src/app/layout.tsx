import type { ReactNode } from 'react';

export const metadata = { title: 'toklyn + Next.js (server-rendered)' };

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body
        style={{ fontFamily: 'system-ui', maxWidth: 640, margin: '2rem auto' }}
      >
        {children}
      </body>
    </html>
  );
}
