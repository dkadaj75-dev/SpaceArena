// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthService } from "../../core/AuthService.js";
import { AuthScreen } from "./AuthScreen.js";

/**
 * The registration contract the owner asked for (2026-08-22): the NICKNAME is
 * required and the email is optional — the reverse of what this screen used to
 * ask for. These tests pin the field wiring, since a swapped argument order in
 * `AuthService.register()` would otherwise register an email as a nickname and
 * still "pass" every server test.
 */

function stubAuth(): AuthService {
  return {
    guest: vi.fn(async () => {}),
    register: vi.fn(async () => {}),
    login: vi.fn(async () => {}),
  } as unknown as AuthService;
}

function mount(auth: AuthService): { screen: AuthScreen; root: HTMLElement } {
  const parent = document.createElement("div");
  document.body.append(parent);
  const screen = new AuthScreen(parent, auth, () => {}, () => {});
  return { screen, root: parent };
}

/** Inputs/buttons of one panel, in DOM order (login panel first, register second). */
function panel(root: HTMLElement, tab: "login" | "register"): { inputs: HTMLInputElement[]; submit: HTMLButtonElement } {
  const panels = root.querySelectorAll<HTMLDivElement>(".sa-screen-panel");
  const el = panels[tab === "login" ? 0 : 1]!;
  return {
    inputs: [...el.querySelectorAll("input")],
    submit: el.querySelector("button")!,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("AuthScreen register form", () => {
  it("asks for a nickname (required) and an email marked optional", () => {
    const { root } = mount(stubAuth());
    const { inputs } = panel(root, "register");
    expect(inputs.map((i) => i.placeholder)).toEqual(["Nickname", "Email (optional)", "Password (min 8 chars)"]);
  });

  it("registers with the nickname and no email when the email box is left empty", async () => {
    const auth = stubAuth();
    const { root } = mount(auth);
    const { inputs, submit } = panel(root, "register");
    inputs[0]!.value = "  Nova Pilot  ";
    inputs[2]!.value = "password123";

    submit.click();
    await vi.waitFor(() => expect(auth.register).toHaveBeenCalled());
    expect(auth.register).toHaveBeenCalledWith("Nova Pilot", "password123", undefined);
  });

  it("passes the email through when one is typed", async () => {
    const auth = stubAuth();
    const { root } = mount(auth);
    const { inputs, submit } = panel(root, "register");
    inputs[0]!.value = "Nova";
    inputs[1]!.value = "nova@example.com";
    inputs[2]!.value = "password123";

    submit.click();
    await vi.waitFor(() => expect(auth.register).toHaveBeenCalled());
    expect(auth.register).toHaveBeenCalledWith("Nova", "password123", "nova@example.com");
  });

  it("refuses to submit without a nickname, and says so instead of calling the API", () => {
    const auth = stubAuth();
    const { root } = mount(auth);
    const { inputs, submit } = panel(root, "register");
    inputs[1]!.value = "nova@example.com";
    inputs[2]!.value = "password123";

    submit.click();
    expect(auth.register).not.toHaveBeenCalled();
    expect(root.querySelector(".sa-screen-error")!.textContent).toBe("Choose a nickname");
  });
});

describe("AuthScreen login form", () => {
  it("takes a nickname OR an email as the identifier", async () => {
    const auth = stubAuth();
    const { root } = mount(auth);
    const { inputs, submit } = panel(root, "login");
    expect(inputs[0]!.placeholder).toBe("Nickname or email");
    // Not type=email: an account registered without one logs in by nickname.
    expect(inputs[0]!.type).toBe("text");

    inputs[0]!.value = " Nova ";
    inputs[1]!.value = "password123";
    submit.click();
    await vi.waitFor(() => expect(auth.login).toHaveBeenCalled());
    expect(auth.login).toHaveBeenCalledWith("Nova", "password123");
  });
});
