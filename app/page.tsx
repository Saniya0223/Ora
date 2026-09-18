import Workspace from "./workspace";

export default function Home() {
  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:bg-paper focus:p-4">
        Skip to content
      </a>
      <header className="border-b border-rule">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-6 sm:px-10">
          <a href="/" className="font-display text-2xl font-bold tracking-tight">
            Campus<span className="text-accent">Flow</span>
          </a>
          <span className="text-xs tracking-widest text-muted uppercase">Demo workspace</span>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-6xl px-6 py-12 sm:px-10 sm:py-16">
        <p className="mb-4 text-xs font-bold tracking-[0.18em] text-accent uppercase">Your academic day</p>
        <h1 className="font-display text-5xl tracking-tight sm:text-6xl">A clearer today.</h1>
        <p className="mt-4 max-w-xl text-base leading-7 text-muted">
          Your deadlines, class times, and next steps. One current plan.
        </p>

        <Workspace />
      </main>

      <footer className="mx-auto mt-8 max-w-6xl px-6 pb-8 sm:px-10">
        <p className="border-t border-rule pt-5 text-xs tracking-wide text-muted">CampusFlow / Less scattered. More settled.</p>
      </footer>
    </div>
  );
}
