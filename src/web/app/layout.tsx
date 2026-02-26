import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Lux Concierge',
  description: 'Ask questions backed by organizational knowledge',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          backgroundColor: '#0a0a0a',
          color: '#e5e5e5',
        }}
      >
        {children}
      </body>
    </html>
  );
}
