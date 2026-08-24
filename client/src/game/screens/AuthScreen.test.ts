// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, type AuthService } from "../../core/AuthService.js";
import { AuthScreen, authFieldError } from "./AuthScreen.js";

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

/** The error line belonging to one input, wherever its panel is. */
function fieldError(root: HTMLElement, field: string): string {
  const lines = [...root.querySelectorAll<HTMLElement>(`[data-field-error="${field}"]`)];
  return lines.map((el) => el.textContent).join("");
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

  it("refuses to submit without a nickname, and says so ON the nickname box", () => {
    const auth = stubAuth();
    const { root } = mount(auth);
    const { inputs, submit } = panel(root, "register");
    inputs[1]!.value = "nova@example.com";
    inputs[2]!.value = "password123";

    submit.click();
    expect(auth.register).not.toHaveBeenCalled();
    expect(fieldError(root, "displayName")).toBe("Choose a nickname");
    // The line above the form stays for whole-attempt failures only.
    expect(root.querySelector(".sa-screen-error")!.textContent).toBe("");
  });
});

/**
 * Findings 5 and 6: the complaint rendered above the form — between "Play as
 * Guest" and the toggle link, up to a whole form away from the box it was
 * about — and it arrived in the schema's own words
 * (`password: Too small: expected string to have >=8 characters`).
 */
describe("AuthScreen validation errors", () => {
  it("translates the server's zod text into something a player can act on", () => {
    expect(authFieldError("password: Too small: expected string to have >=8 characters")).toEqual({
      field: "password",
      message: "Password needs at least 8 characters",
    });
    expect(authFieldError("displayName: Too small: expected string to have >=1 characters")).toEqual({
      field: "displayName",
      message: "Choose a nickname",
    });
    expect(authFieldError("email: Invalid email address")).toEqual({
      field: "email",
      message: "That email address doesn't look right",
    });
  });

  it("leaves an unmapped message alone rather than swallowing it", () => {
    // An unhelpful sentence still beats a blank panel; only the machine-facing
    // field prefix comes off.
    expect(authFieldError("password: some rule nobody has written copy for yet")).toEqual({
      field: "password",
      message: "some rule nobody has written copy for yet",
    });
    expect(authFieldError("Invalid credentials")).toEqual({ field: null, message: "Invalid credentials" });
  });

  it("renders a server field error beside its own input", async () => {
    const auth = stubAuth();
    (auth.register as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiRequestError("invalid-body", "password: Too small: expected string to have >=8 characters", 400),
    );
    const { root } = mount(auth);
    const { inputs, submit } = panel(root, "register");
    inputs[0]!.value = "Nova";
    inputs[2]!.value = "short";

    submit.click();
    await vi.waitFor(() => expect(fieldError(root, "password")).toBe("Password needs at least 8 characters"));
    expect(root.querySelector(".sa-screen-error")!.textContent).toBe("");
  });

  it("keeps a whole-attempt failure above the form, where no one field is at fault", async () => {
    const auth = stubAuth();
    (auth.login as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiRequestError("invalid-credentials", "Invalid credentials", 401),
    );
    const { root } = mount(auth);
    const { inputs, submit } = panel(root, "login");
    inputs[0]!.value = "Nova";
    inputs[1]!.value = "wrong";

    submit.click();
    await vi.waitFor(() => expect(root.querySelector(".sa-screen-error")!.textContent).toBe("Invalid credentials"));
    expect(fieldError(root, "identifier")).toBe("");
  });

  it("clears the complaint as soon as the player answers it", () => {
    const { root } = mount(stubAuth());
    const { inputs, submit } = panel(root, "register");
    submit.click();
    expect(fieldError(root, "displayName")).toBe("Choose a nickname");
    inputs[0]!.value = "Nova";
    inputs[0]!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(fieldError(root, "displayName")).toBe("");
  });
});

/** Finding 4 / match 5: the submit button sat below the fold with no scroll cue. */
describe("AuthScreen fits its viewport", () => {
  it("scrolls the submit into view when a form opens", () => {
    const { screen, root } = mount(stubAuth());
    const submit = panel(root, "register").submit;
    const scrollIntoView = vi.fn();
    submit.scrollIntoView = scrollIntoView;

    screen.showRegisterTab();
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("carries a scroll affordance that is off while everything fits", () => {
    const { root } = mount(stubAuth());
    // happy-dom lays nothing out, so scrollHeight === clientHeight === 0: the
    // "nothing is hidden" case, and the mark must stay down for it.
    expect(root.querySelector<HTMLElement>(".sa-screen-scrollhint")!.dataset["visible"]).toBe("false");
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
