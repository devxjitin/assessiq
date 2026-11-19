import type { ReactNode } from 'react';
import { SiteLinks } from '../components/legal';
import { AuthProvider } from '../lib/auth';
import './globals.css';

export const metadata = {
  title: 'Parakh',
  description: 'Online assessments and verified certificates by NandiVex Technologies',
};

// Runs before first paint so the saved (or system) theme applies without a flash.
const THEME_SCRIPT = `try{var t=localStorage.getItem('aiq-theme');if(!t){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='light'}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <AuthProvider>{children}</AuthProvider>
        <footer className="site-footer">
          <SiteLinks />
          <span>© NandiVex Technologies</span>
        </footer>
      </body>
    </html>
  );
}
