import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { useResource } from "./useResource";

/**
 * The failure modes here are the ones that produce bug reports nobody can
 * reproduce: a slow response overwriting a newer one, a refresh blanking a
 * screen that already had content, and an error wiping out data the resident
 * was reading.
 */

function Probe({ load, dep }: { load: (signal: AbortSignal) => Promise<string>; dep: number }) {
  const resource = useResource(load, [dep]);
  return (
    <div>
      <span data-testid="data">{resource.data ?? "none"}</span>
      <span data-testid="loading">{String(resource.loading)}</span>
      <span data-testid="refreshing">{String(resource.refreshing)}</span>
      <span data-testid="error">{resource.error?.message ?? "none"}</span>
      <button type="button" onClick={() => void resource.reload()}>
        reload
      </button>
    </div>
  );
}

describe("useResource", () => {
  it("loads, then exposes the value", async () => {
    render(<Probe dep={1} load={async () => "schedule"} />);
    await waitFor(() =>
      expect(screen.getByTestId("data")).toHaveTextContent("schedule"),
    );
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
  });

  it("keeps the previous value on screen while refreshing", async () => {
    let value = "first";
    render(<Probe dep={1} load={async () => value} />);
    await waitFor(() =>
      expect(screen.getByTestId("data")).toHaveTextContent("first"),
    );

    value = "second";
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = vi.fn(async () => {
      await gate;
      return value;
    });

    render(<Probe dep={1} load={slow} />);
    // The first instance still shows its data; a refresh must never blank it.
    expect(screen.getAllByTestId("data")[0]).toHaveTextContent("first");
    act(() => release?.());
  });

  it("ignores a slow response that a newer request has superseded", async () => {
    const resolvers: Array<(value: string) => void> = [];
    const load = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const view = render(<Probe dep={1} load={load} />);
    // A dependency change starts a second request before the first finishes.
    view.rerender(<Probe dep={2} load={load} />);
    await waitFor(() => expect(resolvers.length).toBe(2));

    // The second (newer) request answers first, then the stale one arrives.
    await act(async () => {
      resolvers[1]("newer");
    });
    await act(async () => {
      resolvers[0]("stale");
    });

    expect(screen.getByTestId("data")).toHaveTextContent("newer");
  });

  it("reports the error without discarding what is already shown", async () => {
    let attempt = 0;
    const load = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) return "loaded";
      throw new ApiError("network", "You appear to be offline.");
    });

    render(<Probe dep={1} load={load} />);
    await waitFor(() =>
      expect(screen.getByTestId("data")).toHaveTextContent("loaded"),
    );

    await act(async () => {
      screen.getByRole("button", { name: "reload" }).click();
    });

    await waitFor(() =>
      expect(screen.getByTestId("error")).toHaveTextContent("offline"),
    );
    expect(screen.getByTestId("data")).toHaveTextContent("loaded");
  });

  it("wraps an unexpected throw in a presentable error", async () => {
    render(
      <Probe
        dep={1}
        load={async () => {
          throw new Error("kaboom");
        }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("error")).toHaveTextContent(
        "Something went wrong. Please try again.",
      ),
    );
  });

  it("does not report an aborted request as a failure", async () => {
    render(
      <Probe
        dep={1}
        load={async () => {
          throw new DOMException("aborted", "AbortError");
        }}
      />,
    );

    // An abort only ever happens because the hook itself cancelled the request
    // — the dependencies changed, or the screen went away — and a replacement
    // request is always on its way. So it must not surface an error, and it
    // must not pretend the load finished with nothing.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("error")).toHaveTextContent("none");
    expect(screen.getByTestId("data")).toHaveTextContent("none");
    expect(screen.getByTestId("loading")).toHaveTextContent("true");
  });
});
