// The Git rail badge sums `dirty` over EVERY worktree while the Git view shows
// one target at a time, so what must stay inexpressible is a gap between the
// rail total and the sum of the counters actually RENDERED. The regression
// guarded is a field DROPPED in transit, which yields a missing counter or a
// zero and never an exception: the assertions therefore read numbers off the
// DOM. The total is taken from `sumDirty`, the module the rail itself calls,
// so this file never re-states the formula it is comparing against.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased, no runtime resolution
import { mockStore, storeMockStubs } from "./_store-mock";
import { sumDirty } from "../desktop/src/shared/worktree-count.ts";

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const { act, React, createRoot, create } = await import(
  "../desktop/tests-support/react-test-harness"
);

interface FakeSession {
  cwd: string;
  name: string;
  status: string;
  supervisor?: boolean;
}

interface FakeDeckState {
  dict: Record<string, string>;
  sessions: FakeSession[];
  showToast(): void;
  setView(): void;
}

/** Empty dict: i18n's `translate` returns the key itself, so assertions match
 * on key strings and never on a wording that may be re-edited. */
function initialFakeState(): FakeDeckState {
  return {
    dict: {},
    sessions: [{ cwd: "/elsewhere", name: "loose", status: "running" }],
    showToast: () => {},
    setView: () => {},
  };
}

const fakeUseDeck = create<FakeDeckState>(() => initialFakeState());

mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });

// GitView renders two helpers from DiffPanel, which imports '@shared/code-lang'
// through a tsconfig-only alias bun does not resolve from the repo root, and
// pulls the Shiki highlighter; neither is on the path measured here. The
// factory carries DiffPanel's FULL export surface: Bun freezes a specifier's
// export list process-wide at first materialisation, so a partial factory would
// kill an unrelated file later in the same run.
mock.module("../desktop/src/renderer/src/components/DiffPanel.tsx", () => ({
  DiffFileRow: () => null,
  DiffText: () => null,
  DiffPanel: () => null,
}));

/** Three worktrees, and the middle one is the point: main and detached are both
 * SPECIAL, so a fixture holding only those two is reproduced character for
 * character by any partition predicate keyed on `main`, `detached` or
 * `branch === null`. The ORDINARY worktree -- an agent on a branch, neither
 * main nor detached, which is the common case in production -- is what makes a
 * wrong predicate visible. The main carries a NON-ZERO count for the same
 * reason: at zero, dropping it from the total changes no total. */
const WORKTREES = [
  {
    path: "/repo",
    branch: "experimental",
    main: true,
    dirty: 2,
    lastCommit: null,
    sessionId: null,
    sessionName: null,
  },
  {
    path: "/repo-agent",
    branch: "agent/feature",
    main: false,
    dirty: 0,
    lastCommit: null,
    sessionId: null,
    sessionName: null,
  },
  {
    // Detached and named by its directory: the shape of the clone that
    // `git worktree list` reports alongside the real worktrees.
    path: "/repo-mcp",
    branch: null,
    main: false,
    dirty: 3,
    lastCommit: null,
    sessionId: null,
    sessionName: null,
  },
];

/** The rail's own arithmetic, imported rather than copied. */
const RAIL_TOTAL = sumDirty(WORKTREES);

const EMPTY_DIFF = {
  uncommitted: [],
  branch: null,
  base: null,
  text: "",
  truncated: false,
};

(globalThis as unknown as { window: { api: unknown } }).window.api = {
  listWorktrees: async () => WORKTREES,
  collectDiff: async () => EMPTY_DIFF,
  collectFileDiff: async () => null,
  reviewDiff: async () => {},
  reportError: () => {},
};

const { GitView } = await import("../desktop/src/renderer/src/components/GitView");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fakeUseDeck.setState(initialFakeState(), true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

async function mountGit(): Promise<void> {
  await act(async () => {
    root.render(React.createElement(GitView));
  });
}

function lines(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".git-side .git-target")];
}

function counters(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".git-side .git-count")];
}

test("the left panel shows one line per worktree PLUS the live session running outside one", async () => {
  await mountGit();
  // Asserted before any arithmetic: a panel that lost a line would otherwise
  // let a smaller sum look consistent with itself.
  expect(lines().length).toBe(WORKTREES.length + 1);
  const text = container.textContent ?? "";
  expect(text).toContain("experimental");
  expect(text).toContain("agent/feature");
  expect(text).toContain("/elsewhere");
});

test("the rail total equals the sum of the counters the panel renders", async () => {
  await mountGit();
  expect(lines().length).toBe(WORKTREES.length + 1);

  const chips = counters();
  // One counter per WORKTREE line and none elsewhere: a counter on the session
  // line would make the panel sum MORE than the rail, the same defect mirrored.
  expect(chips.length).toBe(WORKTREES.length);

  const values = chips.map((c) => Number((c.textContent ?? "").trim()));
  // An empty pill would give Number("") === 0, not NaN: the digit assertion is
  // what stops a silent zero from passing as a measured zero.
  for (const [i, v] of values.entries()) {
    expect((chips[i]!.textContent ?? "").trim()).toMatch(/^\d+$/);
    expect(Number.isInteger(v)).toBe(true);
  }
  expect(values.reduce((a, b) => a + b, 0)).toBe(RAIL_TOTAL);
});

test("a counted worktree at zero renders a counter, so it never reads like an uncounted line", async () => {
  await mountGit();
  const shown = counters()
    .map((c) => (c.textContent ?? "").trim())
    .sort();
  expect(shown).toEqual(["0", "2", "3"]);
});

// The counting assertions above are POSITION-BLIND: their selectors descend
// through both groups, so they hold just as well with the lines under the wrong
// title. This one pins the panel's whole shape in source order -- which title,
// then which kind of line under it -- because "the badge is reachable" means the
// right line sits under the right title with the mark that identifies it.
test("each line sits under the title that describes it, carrying the mark of its kind", async () => {
  await mountGit();
  const shape = [...container.querySelectorAll<HTMLElement>(".git-side > *")].map((el) =>
    el.classList.contains("git-target")
      ? `${el.querySelector(".git-count") ? "counted" : "plain"}:${el.querySelector("svg") ? "wt" : "bare"}`
      : `title:${(el.textContent ?? "").trim()}`
  );
  expect(shape).toEqual([
    "title:git.groupWorktrees",
    "counted:wt",
    "counted:wt",
    "counted:wt",
    "title:git.groupSessions",
    "plain:bare",
  ]);
});

test("each line still opens its own target in the detail column", async () => {
  await mountGit();
  // The main worktree is selected on load; clicking another line must move the
  // selection, which is the whole point of making the count reachable.
  const other = lines().find((el) => (el.textContent ?? "").includes("repo-mcp"));
  expect(other).toBeTruthy();
  expect(other!.className).not.toContain("is-active");
  await act(async () => {
    other!.click();
  });
  expect(other!.className).toContain("is-active");
});

test("a detached worktree is named by its directory, not by a truncated absolute path", async () => {
  await mountGit();
  const detached = lines().find((el) => (el.textContent ?? "").includes("repo-mcp"));
  expect(detached).toBeTruthy();
  const label = detached!.querySelector(".git-target-label");
  expect((label?.textContent ?? "").trim()).toBe("repo-mcp");
  expect(detached!.getAttribute("title")).toBe("/repo-mcp");
  expect(detached!.textContent).toContain("git.detached");
});
