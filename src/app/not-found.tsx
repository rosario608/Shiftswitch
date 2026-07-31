import Link from "next/link";

export const metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <main id="main" className="mx-auto w-full max-w-md flex-1 px-5 py-16 text-center">
      <h1 className="text-xl font-semibold text-ink">We couldn&rsquo;t find that page</h1>
      <p className="mt-3 text-ink-muted">
        The item may have been completed, cancelled, or it belongs to another program.
      </p>
      <Link
        href="/"
        className="mt-6 inline-flex min-h-[2.75rem] items-center justify-center rounded-xl bg-brand px-5 font-semibold text-white"
      >
        Go to home
      </Link>
    </main>
  );
}
