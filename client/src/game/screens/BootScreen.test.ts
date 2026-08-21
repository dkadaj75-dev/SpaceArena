import { describe, expect, it, vi } from "vitest";
import { BootScreen, PUBLISHER_MS, TITLE_MIN_MS } from "./BootScreen.js";

/** The launch markup, reduced to the hooks the driver actually reaches for. */
function mount(): HTMLElement {
  document.body.innerHTML = `
    <div id="sa-boot" data-phase="publisher">
      <div class="sa-boot-sub" data-boot-sub>LOADING</div>
      <ol>
        <li data-boot-stage="content" data-state="pending"></li>
        <li data-boot-stage="interface" data-state="pending"></li>
        <li data-boot-stage="server" data-state="pending"></li>
      </ol>
      <div data-boot-note></div>
    </div>`;
  return document.getElementById("sa-boot")!;
}

describe("launch sequence", () => {
  it("opens on the publisher card and moves to the title on its own", async () => {
    vi.useFakeTimers();
    const root = mount();
    BootScreen.attach();
    expect(root.dataset["phase"]).toBe("publisher");
    await vi.advanceTimersByTimeAsync(PUBLISHER_MS);
    expect(root.dataset["phase"]).toBe("title");
    vi.useRealTimers();
  });

  it("holds the title screen its full beat even when the pack loads instantly", async () => {
    // The bug this guards: a fast load dismissing mid-animation, so the player
    // sees a flash of logo and a stutter of black instead of a launch.
    vi.useFakeTimers();
    const root = mount();
    const boot = BootScreen.attach()!;
    const done = vi.fn();
    void boot.dismiss().then(done);

    await vi.advanceTimersByTimeAsync(PUBLISHER_MS + TITLE_MIN_MS - 50);
    expect(done).not.toHaveBeenCalled();
    expect(root.isConnected).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toHaveBeenCalled();
    expect(root.isConnected).toBe(false);
    vi.useRealTimers();
  });

  it("adds the caller's hold ON TOP of the sequence, for a message to be read", async () => {
    vi.useFakeTimers();
    mount();
    const boot = BootScreen.attach()!;
    const done = vi.fn();
    void boot.dismiss(1600).then(done);
    await vi.advanceTimersByTimeAsync(PUBLISHER_MS + TITLE_MIN_MS + 100);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(done).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("jumps a failure straight to the screen with room to explain it", () => {
    const root = mount();
    const boot = BootScreen.attach()!;
    boot.fail("content pack unreadable");
    expect(root.dataset["phase"]).toBe("title");
    expect(root.dataset["state"]).toBe("failed");
    expect(root.querySelector("[data-boot-note]")?.textContent).toContain("unreadable");
  });

  it("marks stages as they settle, so the indicator carries real progress", () => {
    const root = mount();
    const boot = BootScreen.attach()!;
    boot.begin("content");
    expect(root.querySelector('[data-boot-stage="content"]')?.getAttribute("data-state")).toBe("active");
    boot.settle("content", "ok", "176 configs");
    boot.settle("server", "warn", "unreachable");
    expect(root.querySelector('[data-boot-stage="content"]')?.getAttribute("data-state")).toBe("ok");
    expect(root.querySelector('[data-boot-stage="server"]')?.getAttribute("data-state")).toBe("warn");
  });

  it("comes back as a curtain after it has been dismissed, and cycles", async () => {
    // What this guards: leaving a match re-uses the launch screen to cover the
    // menu's rebuild, so `dismiss` removing the node must not be the end of it.
    vi.useFakeTimers();
    const root = mount();
    const boot = BootScreen.attach()!;
    void boot.dismiss();
    await vi.advanceTimersByTimeAsync(PUBLISHER_MS + TITLE_MIN_MS + 1000);
    expect(root.isConnected).toBe(false);

    boot.cover();
    expect(root.isConnected).toBe(true);
    // Straight to the title: a return trip has no publisher card to play.
    expect(root.dataset["phase"]).toBe("title");
    expect(root.dataset["mode"]).toBe("curtain");
    // No leftover fade-out, or the curtain would enter already transparent and
    // show the very teardown it exists to hide.
    expect(root.dataset["state"]).toBeUndefined();
    expect(root.querySelector("[data-boot-sub]")?.textContent).toBe("LOADING");

    void boot.dismiss();
    await vi.advanceTimersByTimeAsync(1000);
    expect(root.isConnected).toBe(false);
    // ...and again, because a player can leave as many matches as they like.
    boot.cover("RETURNING");
    expect(root.isConnected).toBe(true);
    expect(root.querySelector("[data-boot-sub]")?.textContent).toBe("RETURNING");
    vi.useRealTimers();
  });

  it("is a no-op with no markup, so a stripped embed does not have to null-check", () => {
    document.body.innerHTML = "";
    expect(BootScreen.attach()).toBeNull();
  });
});
