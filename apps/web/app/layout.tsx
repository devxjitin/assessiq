import type { ReactNode } from 'react';
import { AuthProvider } from '../lib/auth';
import './globals.css';

export const metadata = {
  title: 'AssessIQ',
  description: 'Online assessments and verified certificates by NandiVex Technologies',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
