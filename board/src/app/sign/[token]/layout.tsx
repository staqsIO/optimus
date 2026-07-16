/**
 * Public signing page layout — renders OUTSIDE the Board shell.
 * The middleware.ts excludes /sign/ from auth, so no session required.
 * This layout hides the HeaderBar/SideNav by rendering children
 * in a full-screen overlay that covers the Board shell beneath.
 */
export default function SignLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[100] bg-zinc-950 overflow-y-auto">
      <link
        href="https://fonts.googleapis.com/css2?family=Dancing+Script:wght@700&display=swap"
        rel="stylesheet"
      />
      {children}
    </div>
  );
}
