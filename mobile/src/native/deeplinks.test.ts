import { describe, expect, it } from "vitest";
import { routeFromUrl } from "./deeplinks";
import { isAuthCallback } from "@/auth/session";

/**
 * Deep-link routing decides where a resident lands when they tap a
 * notification or a link a colleague sent. Two failures matter: sending them
 * to the wrong place, and — worse — following a URL that did not come from
 * this app's own origin.
 */

const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("routeFromUrl", () => {
  it("routes universal links from the app's own origin", () => {
    expect(routeFromUrl(`http://localhost:3000/trades/${UUID}`)).toBe(
      `/switches/${UUID}`,
    );
    expect(routeFromUrl(`http://localhost:3000/switches/${UUID}`)).toBe(
      `/switches/${UUID}`,
    );
    expect(routeFromUrl(`http://localhost:3000/schedule/${UUID}`)).toBe(
      `/schedule/${UUID}`,
    );
    expect(routeFromUrl("http://localhost:3000/notifications")).toBe(
      "/notifications",
    );
  });

  it("routes the custom scheme, where the path is parsed as host + path", () => {
    expect(routeFromUrl(`shiftswitch://trades/${UUID}`)).toBe(`/switches/${UUID}`);
    expect(routeFromUrl("shiftswitch://schedule")).toBe("/schedule");
  });

  it("maps the web app's chief approvals path onto the app's own", () => {
    expect(routeFromUrl("http://localhost:3000/admin/approvals")).toBe(
      "/approvals",
    );
  });

  it("refuses links from any other origin", () => {
    expect(routeFromUrl(`https://evil.example.com/trades/${UUID}`)).toBeNull();
    expect(
      routeFromUrl(`https://localhost.evil.example.com/trades/${UUID}`),
    ).toBeNull();
  });

  it("refuses paths the app does not own", () => {
    expect(routeFromUrl("http://localhost:3000/admin/users")).toBeNull();
    expect(routeFromUrl("http://localhost:3000/api/session")).toBeNull();
    expect(routeFromUrl("http://localhost:3000/trades/not-a-uuid")).toBeNull();
  });

  it("refuses a malformed URL rather than throwing", () => {
    expect(routeFromUrl("not a url")).toBeNull();
    expect(routeFromUrl("")).toBeNull();
  });

  it("ignores a trailing slash", () => {
    expect(routeFromUrl("http://localhost:3000/trades/")).toBe("/switches");
  });
});

describe("isAuthCallback", () => {
  it("recognises only the sign-in callback", () => {
    expect(isAuthCallback("shiftswitch://auth/callback?code=abc")).toBe(true);
    expect(isAuthCallback(`shiftswitch://trades/${UUID}`)).toBe(false);
    expect(isAuthCallback("https://evil.example.com/auth/callback")).toBe(false);
  });
});
