// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderRoster } from "./MatchLoadingScreen.js";

describe("match loading roster", () => {
  it("renders every player under the correct ordered team", () => {
    const host = document.createElement("div");
    renderRoster(host, [
      { team: 1, name: "Red Bot" }, { team: 0, name: "Player" }, { team: 0, name: "Wing Bot" },
    ]);
    const teams = host.querySelectorAll<HTMLElement>(".sa-match-loading-team");
    expect([...teams].map((team) => team.dataset["team"])).toEqual(["0", "1"]);
    expect([...teams[0]!.querySelectorAll(".sa-match-loading-pilot")].map((el) => el.textContent)).toEqual(["Player", "Wing Bot"]);
    expect(teams[1]!.textContent).toContain("Red Bot");
  });
});
