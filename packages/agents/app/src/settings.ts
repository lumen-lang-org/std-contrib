// Settings: the database rows the platform runs on, editable while it runs —
// which is the point of the whole package.
//
// Every tab is the same shape, and the shape is borrowed from a settings modal
// with twice as many tabs as this one: a titled head over a hairline, the one
// action that makes a new row on the right, rows gathered under an uppercase
// group label with its count, and — this is the part that matters — a form
// that *replaces* the list instead of sitting underneath it as a strip of
// unlabelled boxes.
//
// What was here before was that strip: a `<table>` and a row of bare inputs
// whose only clue was a placeholder. A placeholder is not a label; it leaves
// the moment you type, so a half-filled form is a row of anonymous values.
//
// The layout is taken. The palette is not: this console's action colour is
// ink, and borrowing another product's indigo would have made it look like
// that product.

import { LitElement, css, html } from "lit";
import "./mcp-gallery.js";
import { customElement, property, state } from "lit/decorators.js";
import {
  AgentFull, AgentRow, ModelChoiceRow, ModelConfigRow, ModelRouterRow, ModelRow, PromptRow,
  RouterCandidate, ScriptImageRow, ServerRow,
  SkillFileRow, SkillRow, TracingStatus,
  configureTracing, createAgent, createConfig, createModel, createPrompt,
  createScriptImage, createServer, createSkill, createSkillFile, deleteAgent, deleteConfig,
  deleteModel, deleteScriptImage, deleteServer, deleteSkill, deleteSkillFile,
  updateConfig, updateScriptImage, listScriptImages,
  listAgents, listConfigs, listModels, listPrompts, listProviders, listServers,
  listSkillFiles, listSkills, linkSkill, unlinkSkill,
  createModelChoice, deleteModelChoice, listModelChoices, rankChoice, updateModelChoice,
  createRouter, deleteRouter, listRouters, updateRouter,
  TemplateRow, listTemplates, deleteTemplate,
  PluginRow, PluginItem, PluginPreview, listPlugins, pluginItems, inspectPlugin, installPlugin, removePlugin,
  serverMine, setServerMine, forgetServerMine,
  AuthProviderRow, listAuthProviders, saveAuthProvider, setAuthProviderSecret, deleteAuthProvider,
  setTracingSecret, storeProviderKey, tracingStatus,
  updateAgent, updateModel, updateServer, updateSkill, updateSkillFile, setServerAuth, testModel,
  Me, isAdmin,
} from "./api.js";

// Each tab, with the mark that stands for it in the rail. The icons are the
// ones nr-icon carries — a name it does not have is drawn as the name itself.
// Every tab, and WHOSE it is. Two zones, one element: the user zone is what
// people author — agents, prompts, skills, templates, and the connectors and
// plugins they browse in the directory — and it renders in the overlay the
// account menu opens. The admin zone is what makes the deployment run at all:
// model rows, provider keys, script images, tracing, the raw MCP table. It
// renders at /admin, behind the gateway's admin check.
//
// The split is by ownership rather than by screen, because the first cut of
// this got it wrong in exactly that way: settings became a page and the page
// was all twelve tabs, so "user configuration" and "what makes Joule work"
// were still one surface with one audience. A models row is not something a
// person configures about themselves; a prompt is not infrastructure.
//
// On the three acquisition nouns (skills you write, connectors you address,
// plugins you install) — the note that used to live mid-list — see the
// directory in console.ts, which is their browsing surface.
const TABS = [
  // First and the overlay's opening tab: what a person came to change is
  // usually their own — the deployment's authoring tabs are one click right.
  { name: "Preferences", icon: "settings", zone: "user" },
  { name: "Agents", icon: "message-square", zone: "user" },
  { name: "Prompts", icon: "file-text", zone: "user" },
  { name: "Skills", icon: "sticky-note", zone: "user" },
  { name: "Templates", icon: "file-text", zone: "user" },
  { name: "Connectors", icon: "plug", zone: "user" },
  { name: "Plugins", icon: "cube", zone: "user" },
  { name: "Models", icon: "zap", zone: "admin" },
  { name: "Model menu", icon: "list", zone: "admin" },
  { name: "Providers", icon: "cloud", zone: "admin" },
  { name: "Images", icon: "box", zone: "admin" },
  // The raw server table. The Connectors tab above is the browsing face of
  // the same rows; this is the one with transports and auth headers on it,
  // which is operator work even when the row began as somebody's browse.
  { name: "MCP", icon: "code", zone: "admin" },
  { name: "Sign-in", icon: "log-in", zone: "admin" },
  { name: "Tracing", icon: "layers", zone: "admin" },
] as const;
type Tab = typeof TABS[number]["name"];
type Zone = typeof TABS[number]["zone"];

// "vertex" authenticates with a whole service-account JSON pasted as the
// key; the server mints short-lived OAuth tokens from it per request.
const PROVIDERS = ["mistral", "openai", "anthropic", "vertex"];
const BACKENDS = ["langfuse", "otlp", "phoenix", "braintrust", "langsmith", "arize"];

// The value a LumenUI field is now carrying. Read off the element rather than
// out of the event detail: nr-input, nr-select and nr-textarea each describe
// their payload differently, and `value` is the one thing all three agree on.
function valueOf(e: Event): string {
  return (e.target as unknown as { value?: string }).value ?? "";
}

const options = (values: string[]) => values.map((v) => ({ value: v, label: v }));

// The values this form offers, plus whatever the row already holds. A row
// stored before the list was what it is now still shows what it actually is,
// rather than being silently redrawn as the first option that happens to fit.
const withCurrent = (values: string[], current: string) =>
  options(current === "" || values.includes(current) ? values : [...values, current]);

// What is open on top of a list. A form replaces its list, so this is one
// value rather than a flag per table.
type View =
  | { kind: "list" }
  | { kind: "agent"; row: AgentRow; fresh: boolean }
  | { kind: "model"; row: ModelRow; fresh: boolean }
  | { kind: "config"; row: ModelConfigRow; fresh: boolean }
  // One row of the composer's menu, and the router one of those rows can name.
  | { kind: "choice"; row: ModelChoiceRow; fresh: boolean }
  | { kind: "router"; row: ModelRouterRow; fresh: boolean }
  | { kind: "prompt"; row: { promptName: string; body: string } }
  // A skill's files ride the view: they are loaded when the form opens and
  // edited beside the body, each write its own call.
  | { kind: "skill"; row: SkillRow; fresh: boolean; files: SkillFileRow[] }
  | { kind: "server"; row: ServerRow & { token: string }; fresh: boolean }
  | { kind: "image"; row: ScriptImageRow }
  | { kind: "key"; row: { provider: string; apiKey: string } }
  | { kind: "authp"; row: AuthProviderRow; fresh: boolean };

const NEW_AGENT: AgentRow = {
  id: "", agentName: "", description: "", modelConfigId: "", promptId: "",
  enabled: true, isDefault: false, scriptImageId: "",
};
const NEW_MODEL: ModelRow = {
  id: "", label: "", apiName: "", provider: "mistral", kind: "chat",
  dimensions: 0, baseUrl: "", enabled: true,
};
// `selectable` and `rank` are the row's own flags, not the menu: a config is
// offered where somebody picks a config, and model_choices is a separate list
// an operator curates by hand.
const NEW_CONFIG: ModelConfigRow = {
  id: "", modelId: "", temperature: 0.2, maxTokens: 4096, topP: 1, extra: "",
  thinking: "", label: "", selectable: true, rank: 0,
};
const NEW_CHOICE: ModelChoiceRow = {
  id: "", label: "", description: "", kind: "config", configId: "", routerId: "",
  tier: "", enabled: true, rank: 0,
};
// "turn" and not "thread", because per-turn is what the design describes and
// what a person expects: the choice follows the message, not the conversation.
const NEW_ROUTER: ModelRouterRow = {
  id: "", label: "", routerConfigId: "", fallbackConfigId: "", routeEvery: "turn",
  escalateOnly: false, enabled: true, candidates: [],
};
const NEW_SERVER: ServerRow & { token: string } = {
  id: "", serverName: "", transport: "http", endpoint: "",
  authKind: "none", authHeader: "", enabled: true, token: "",
};

// What markdown looks like while it is being written. Weight and shape carry
// most of it — a heading is heavier, emphasis leans, a quote greys out — with
// one hue for the two things that are addresses rather than prose: a link and
// a piece of code.
const MARKDOWN_TOKENS = `
  .hljs-section { color: var(--fg, #17171A); font-weight: 650; }
  .hljs-strong { font-weight: 700; }
  .hljs-emphasis { font-style: italic; }
  .hljs-bullet { color: var(--muted, #6B6B76); }
  .hljs-quote { color: var(--muted, #6B6B76); font-style: italic; }
  .hljs-code { color: #0F766E; }
  .hljs-link, .hljs-symbol { color: var(--focus, #2563EB); }
`;

@customElement("console-settings")
export class ConsoleSettings extends LitElement {
  static styles = css`
    /* The overlay inside is fixed and out of flow, which leaves this host with
       no box at all — and an element with no box is not "visible" to anything
       that asks, from a test to a screen reader. So the host stays a layer of
       its own and the overlay fills it. */
    :host { position: fixed; inset: 0; z-index: 40; }
    /* As a page it is not a layer over anything: it fills the route's box and
       scrolls inside it, so there is no fixed positioning to fight with and
       nothing to close. The body below needs a height to divide between its
       rail and its content, which on a page is the viewport rather than the
       overlay's card. */
    :host([page]) { position: static; inset: auto; z-index: auto;
                    display: block; height: 100%; }
    :host([page]) .body { height: 100%; }

    /* The surface, its scrim, its header and its dismissal all belong to
       nr-overlay. What is left here is the settings layout itself. */
    nr-overlay {
      /* Wider and taller than the component's default card. The user zone
         holds tables — skills with descriptions, connector endpoints — and at
         1040px the description column was the one doing all the truncating.
         Height rises with it: a wide short card is a letterbox. Both stay
         viewport-bounded, so a laptop gets the margins it always had. */
      --nuraly-overlay-width: min(1320px, 96vw);
      --nuraly-overlay-height: min(860px, 92vh);
      --nuraly-color-overlay-surface: var(--bg);
      --nuraly-color-overlay-border: var(--border);
      --nuraly-color-overlay-text: var(--fg);
      --nuraly-color-overlay-muted: var(--muted);
      --nuraly-color-overlay-hover: var(--bg-sunken);
    }

    .body { flex: 1; display: flex; min-height: 0; width: 100%; }
    /* A page has the whole window, so the content column stops sprawling: a
       table measured across 1900px is a table nobody can follow from one
       column to the next. Wider than the overlay ever was, bounded well short
       of the screen. */
    :host([page]) main { max-width: 1180px; }

    /* Left rail. Each item is an icon and a word; the active one is a filled
       pill rather than a coloured word, so the eye finds it by shape. */
    aside { width: 216px; flex: none; border-right: 1px solid var(--border);
            background: var(--bg-rail); padding: 12px 8px; overflow-y: auto; }
    aside .label { font-size: 11px; letter-spacing: 0.09em; text-transform: uppercase;
                   color: var(--muted); font-weight: 600; padding: 4px 10px 8px; }
    aside .item { display: flex; align-items: center; gap: 10px; padding: 8px 10px;
                  border-radius: 8px; cursor: pointer; color: var(--muted);
                  font-size: 14px; margin-bottom: 1px; }
    aside .item:hover { background: var(--bg-sunken); color: var(--fg); }
    aside .item.on { background: var(--bg-sunken); color: var(--fg); font-weight: 500; }
    aside .item .ic { width: 16px; display: grid; place-items: center; opacity: 0.8; }

    main { flex: 1; overflow-y: auto; padding: 22px 26px 40px; min-width: 0; }
    /* Preferences: the theme picker is three buttons in one track, the choice
       filled rather than ticked — the capability chips' shape, not a new
       control. Bounded: a segmented control the width of a settings page
       reads as three toolbar buttons. */
    .seg { display: flex; gap: 4px; padding: 4px; border-radius: 12px;
           background: var(--bg-sunken); max-width: 420px; }
    .seg button { flex: 1; display: flex; align-items: center; justify-content: center;
                  gap: 7px; padding: 8px 6px; border: 0; border-radius: 9px;
                  background: none; font: inherit; font-size: 13.5px;
                  color: var(--muted); cursor: pointer;
                  transition: background-color .15s cubic-bezier(.23,1,.32,1),
                              color .15s cubic-bezier(.23,1,.32,1); }
    .seg button:hover { color: var(--fg); }
    .seg button.on { background: var(--bg-card); color: var(--fg);
                     font-weight: 550; box-shadow: 0 1px 2px rgba(0,0,0,.12); }
    /* The ready-made shelf on the Sign-in tab. The same card mcp-gallery
       draws, restated here because that component owns its own shadow root
       and its styles do not reach a card rendered in this one. */
    .cards { display: grid; gap: 10px; margin-top: 4px;
             grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
    .cards .card { display: flex; flex-direction: column; gap: 6px; padding: 14px;
                   border: 1px solid var(--border); border-radius: 12px;
                   background: var(--bg-card); }
    .cards .top { display: flex; align-items: center; gap: 8px; }
    .cards .name { font-size: 14px; font-weight: 600; color: var(--fg); }
    .cards .what { font-size: 12.5px; color: var(--muted); line-height: 1.45; }
    .cards .needs { font-size: 12px; color: var(--faint); line-height: 1.4; }
    .cards .foot { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
    .cards .have { font-size: 13px; color: var(--ok, #157F4D); }
    .who { display: flex; align-items: center; gap: 11px; }
    .avatar { display: grid; place-items: center; width: 34px; height: 34px;
              border-radius: 999px; background: var(--fg); color: var(--bg);
              font-weight: 650; font-size: 14px; flex: none; }
    .who .mail { min-width: 0; font-size: 14px; overflow: hidden;
                 text-overflow: ellipsis; white-space: nowrap; }

    /* On a phone the two-column shell does not fit, and pretending it does is
       what the screenshot showed: a 216px rail plus content squeezed into
       whatever the open drawer left, with every table clipped on the right.
       The rail becomes a horizontal strip of tabs above the content — the
       same information, laid out the way a narrow screen can hold it — and
       main gets the whole width with its padding halved.

       1024px, matching the console's own breakpoint: below it the shell is
       already a single column with drawers, so settings has to stop being two
       columns at exactly the same width or the two disagree about what a
       narrow screen is. */
    @media (max-width: 1024px) {
      .body { flex-direction: column; }
      aside {
        width: 100%; flex: none;
        border-right: 0; border-bottom: 1px solid var(--border);
        display: flex; flex-direction: row; gap: 2px;
        overflow-x: auto; scrollbar-width: none;
        padding: 8px 10px;
      }
      aside::-webkit-scrollbar { display: none; }
      /* The group label is a column heading; a row of tabs has no room for
         one and no need of it. */
      aside .label { display: none; }
      aside .item { flex: none; white-space: nowrap; border-radius: 999px; }
      main { padding: 18px 14px 32px; }
      /* A table wider than the phone scrolls inside its own box rather than
         dragging the panel — the rule the console's head.html states for the
         page, applied to the one region here that can genuinely be wide. */
      table { display: block; overflow-x: auto; }
    }

    /* Page head: what this tab is, over a hairline that runs the width of the
       page. The hairline is what makes the head a head rather than a first
       paragraph. */
    .head { display: flex; align-items: center; gap: 10px;
            padding-bottom: 14px; border-bottom: 1px solid var(--border); }
    .head h2 { margin: 0; font-size: 19px; font-weight: 600;
               letter-spacing: -0.01em; flex: 1; }
    .head .ic { color: var(--muted); }

    /* The actions that make new rows, right-aligned under the rule. */
    .bar { display: flex; justify-content: flex-end; gap: 8px; margin: 16px 0 2px; }

    .primary, .ghost { border-radius: 8px; padding: 8px 14px; font: inherit;
                       font-weight: 500; cursor: pointer;
                       display: inline-flex; align-items: center; gap: 6px; }
    .primary { background: var(--accent); color: var(--accent-fg); border: 0; }
    .primary:hover { background: var(--accent-hover); }
    .ghost { background: var(--bg); color: var(--fg); border: 1px solid var(--border); }
    .ghost:hover { background: var(--bg-sunken); }

    /* A group of rows, headed by what it is and how many. */
    .group { display: flex; align-items: baseline; padding: 20px 2px 4px; }
    .group .label { flex: 1; font-size: 11px; letter-spacing: 0.09em;
                    text-transform: uppercase; color: var(--muted); font-weight: 600; }
    .group .n { color: var(--muted); font-size: 12.5px; font-variant-numeric: tabular-nums; }

    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    td, th { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-weight: 500; font-size: 12.5px; }
    tbody tr:hover { background: var(--bg-rail); }
    td.right { text-align: right; white-space: nowrap; width: 1%; }
    td.name { font-weight: 500; white-space: nowrap; }
    td.fill { width: 60%; }

    /* An id is a value to copy, not prose: monospace, on a sunken chip. */
    .slug { font-family: var(--mono); font-size: 12.5px; background: var(--bg-sunken);
            border-radius: 6px; padding: 2px 8px; color: var(--fg);
            white-space: nowrap; }
    /* A tag is a label something was given, not a value it holds. */
    .tag { font-size: 12.5px; background: var(--bg-sunken); border-radius: 999px;
           padding: 2px 10px; color: var(--muted); font-style: italic;
           white-space: nowrap; }
    .tag.live { color: var(--ok); font-style: normal; }
    .tag.off { color: var(--danger); font-style: normal; }
    .dim { color: var(--muted); }
    .trunc { display: block; max-width: 46ch; overflow: hidden;
             text-overflow: ellipsis; white-space: nowrap; }

    /* Row actions: ghosts until the row is under the pointer. */
    .acts { display: inline-flex; gap: 2px; }
    .act { background: none; border: 0; color: var(--muted); cursor: pointer;
           padding: 5px 6px; border-radius: 6px; line-height: 0; }
    .act:hover { background: var(--bg-sunken); color: var(--fg); }
    .act.danger:hover { color: var(--danger); }

    /* --- forms ------------------------------------------------------------ */

    .formhead { display: flex; align-items: center; gap: 12px; margin: 18px 0 20px; }
    .formhead h3 { margin: 0; font-size: 16px; font-weight: 500; }

    /* Something true about the row that no field can hold. */
    .banner { background: var(--bg-rail); border: 1px solid var(--border);
              border-radius: 8px; padding: 11px 14px; color: var(--muted);
              margin-bottom: 22px; }

    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 20px 24px; max-width: 1000px; align-items: start; }
    .f { display: flex; flex-direction: column; min-width: 0; }
    .f.wide { grid-column: 1 / -1; }
    .f .help { margin: 6px 0 0; font-size: 12.5px; color: var(--muted); line-height: 1.45; }
    /* The label belongs to the field, so it is slotted into the component
       rather than sitting beside it — that is what a screen reader reads. */
    [slot="label"], .f > .label { display: block; font-size: 13px; font-weight: 500;
                     margin-bottom: 6px; color: var(--fg); }
    /* The editor keeps the border the rest of the fields have, and a ground
       that is the page rather than the component's own near-white. */
    nr-code-editor::part(editor-container) {
      border-color: var(--border); background: var(--bg-card);
    }
    .req { color: var(--danger); font-style: normal; margin-left: 2px; }
    nr-input, nr-select, nr-textarea { display: block; width: 100%; }
    /* nr-dropdown is an inline-block trigger by nature — it wraps whatever
       opens the menu — so a form field made of one has to be told to fill its
       column like the boxes around it. */
    nr-dropdown.pick { display: block; width: 100%; }
    /* The closed field. This is the whole of what a select gave for free: a
       bordered box that looks like the inputs beside it, the current value on
       the left and a chevron on the right. Written here rather than taken from
       the component because nr-dropdown draws no face at all — the trigger is
       whatever is slotted, which is exactly why it can be made to match. */
    .pick-face {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      width: 100%; box-sizing: border-box; padding: 7px 10px; cursor: pointer;
      border: 1px solid var(--border); border-radius: 6px;
      background: var(--bg-card); color: var(--fg);
      font: inherit; font-size: 13px; text-align: left;
    }
    .pick-face:hover { border-color: var(--muted); }
    /* Clicking must leave no ring behind. :focus-visible alone would already
       do that — a mouse click does not match it — but the browser's default
       :focus outline does, so it is turned off explicitly and the keyboard
       case is drawn as a border colour rather than as a second box outside
       the field. */
    .pick-face:focus,
    .pick-face:focus-visible { outline: none; }
    .pick-face:focus-visible { border-color: var(--accent); }
    /* A long config id must not push the chevron out of the box. */
    .pick-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* A checkbox is its own label, so it needs the room a label would take. */
    .f.check { justify-content: end; padding-top: 22px; }
    /* LumenUI fills a checked box violet — a hue this console spends on the
       graph, where a colour means which kind of node something is. The colour
       is hard-coded inside the component, so its exposed part is the way in. */
    nr-checkbox[checked]::part(input) {
      background-color: var(--accent); border-color: var(--accent);
    }
    nr-checkbox:hover::part(input) { border-color: var(--accent); }

    .formacts { display: flex; gap: 8px; margin-top: 26px; padding-top: 18px;
                border-top: 1px solid var(--border); max-width: 1000px; }

    /* A menu entry is drawn here the way the composer draws it: the label on
       one line, the description under it. An operator editing the menu should
       be looking at the menu, not at a row of columns that happen to hold the
       same strings. */
    .menuname { display: flex; align-items: center; gap: 6px; font-weight: 500; }
    .sub { display: block; color: var(--muted); font-size: 12.5px;
           margin-top: 2px; max-width: 56ch; }
    td.ord { width: 1%; white-space: nowrap; padding-right: 0; }
    /* The row the picker always adds under the list, shown so the menu on this
       page and the menu in the composer are the same length. */
    tr.tail td { color: var(--muted); font-style: italic; }

    /* One router candidate, in a card of its own. The route description is
       prose an operator writes for the routing model, so it gets the room
       prose needs — a strip of one-line inputs is exactly what this editor
       must not be. */
    .cand { border: 1px solid var(--border); border-radius: 10px;
            padding: 14px 16px 2px; margin: 0 0 12px; max-width: 1000px; }
    .cand .top { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
    .cand .top .n { color: var(--muted); font-size: 12.5px;
                    font-variant-numeric: tabular-nums; }
    .cand .top .who { flex: 1; font-weight: 500; }

    .note { color: var(--muted); font-style: italic; margin-top: 22px; }
    .err { color: var(--danger); margin: 12px 0 0; }
    .said { color: var(--muted); margin: 12px 0 0;
            font-family: var(--mono); font-size: 12.5px; }
    .empty { color: var(--muted); padding: 18px 2px; }

    :focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
  `;

  @property() tab: Tab = "Preferences";
  @state() private agents: AgentFull[] = [];
  @state() private models: ModelRow[] = [];
  @state() private configs: ModelConfigRow[] = [];
  // The menu as the engine orders it. Never re-sorted here: the order IS the
  // stored rank, and a second opinion about it on the way to the screen is a
  // second thing to keep true.
  @state() private choices: ModelChoiceRow[] = [];
  @state() private routers: ModelRouterRow[] = [];
  // Why the menu could not be read, when it could not. Its own field rather
  // than `problem`, which is cleared by every other tab's next write.
  @state() private menuProblem = "";
  @state() private prompts: PromptRow[] = [];
  @state() private skills: SkillRow[] = [];
  @state() private templates: TemplateRow[] = [];
  @state() private images: ScriptImageRow[] = [];
  // The agent form's skill checklist, drafted here and diffed against the
  // stored links on save — the canvas's diff-apply idea, in form clothes.
  @state() private skillDraft: string[] = [];
  @state() private servers: ServerRow[] = [];
  // Bundles, and what each one brought — the second is a map rather than a
  // field on the row because the engine keeps the receipts in their own table
  // and a plugin row that carried its items would be a join the list view
  // pays for whether or not anybody expands anything.
  @state() private plugins: PluginRow[] = [];
  @state() private pluginBrought = new Map<string, PluginItem[]>();
  @state() private pluginUrl = "";
  @state() private preview: PluginPreview | null = null;
  @state() private pluginBusy = false;
  /* Which connectors carry a token of the caller's own — id to stored. */
  @state() private mine = new Map<string, boolean>();
  @state() private authProviders: AuthProviderRow[] = [];
  @state() private providers: string[] = [];
  @state() private tracing: TracingStatus | null = null;
  @state() private problem = "";
  @state() private view: View = { kind: "list" };
  /* Drawn as a page rather than inside an overlay. A property, not a second
     element: the difference is a frame and a navigation, and everything else
     — every tab, every form, every refusal — is the same code. */
  @property({ type: Boolean }) page = false;
  /* Which zone's tabs this instance offers. The overlay is the user zone; the
     /admin route sets "admin". A zone, not a tab list: the caller should not
     be able to compose a surface the split does not describe. */
  @property({ type: String }) zone: Zone = "user";
  /* Who is signed in — the Preferences tab shows it. Handed down rather than
     fetched: the console already asked /whoami, and a second ask can only
     agree with the first. */
  @property({ attribute: false }) me: Me | null = null;
  @state() private themeChoice: "system" | "light" | "dark" = "system";
  // What the last Test said, so the answer appears where the button is.
  @state() private probed = "";
  // The tracing panel is a form with no list, so its draft lives here.
  @state() private trace = {
    backend: "langfuse", endpoint: "", publicKey: "",
    serviceName: "lumen-agents", environment: "production", enabled: false,
    secret: "",
  };

  async connectedCallback() {
    super.connectedCallback();
    let held = "system";
    try { held = localStorage.getItem("joule-theme") ?? "system"; } catch { /* private mode */ }
    this.themeChoice = held === "light" || held === "dark" ? held : "system";
    await this.refresh();
  }

  // highlight.js labels markdown with token classes the editor's own
  // stylesheet has no colours for: it dresses javascript, json and css and
  // stops there, so a prompt highlighted "as markdown" came out uniformly
  // black — spans everywhere, not one of them visible. The spans live inside
  // that component's shadow root, where a rule of ours cannot reach, so the
  // sheet is handed to the root itself. Custom properties do cross a shadow
  // boundary, which is what keeps this on the console's palette instead of
  // introducing a second one.
  protected updated() {
    for (const el of this.renderRoot.querySelectorAll("nr-code-editor")) {
      const root = el.shadowRoot as (ShadowRoot & { dressed?: boolean }) | null;
      if (root === null || root.dressed === true) continue;
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(MARKDOWN_TOKENS);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      root.dressed = true;
    }
  }

  private async refresh() {
    this.problem = "";
    try {
      [this.agents, this.models, this.configs, this.prompts, this.servers, this.providers, this.tracing, this.images, this.skills, this.templates] =
        await Promise.all([
          listAgents(), listModels(), listConfigs(), listPrompts(),
          listServers(), listProviders(), tracingStatus(), listScriptImages(), listSkills(),
        listTemplates(),
        ]);
      await this.readMenu();
      await this.loadPlugins();
      await this.loadMine();
      this.authProviders = await listAuthProviders().catch(() => []);
      const t = this.tracing;
      if (t !== null) {
        this.trace = {
          ...this.trace,
          backend: t.backend === "" ? "langfuse" : t.backend,
          endpoint: t.endpoint,
          serviceName: t.serviceName === "" ? "lumen-agents" : t.serviceName,
          environment: t.environment === "" ? "production" : t.environment,
          enabled: t.active,
        };
      }
    } catch (e) { this.problem = e instanceof Error ? e.message : String(e); }
  }

  // The menu and its routers, read on their own and caught on their own.
  //
  // Not part of the read above, and this is not tidiness. These two routes are
  // newer than every other row this modal edits, so an engine that has not been
  // restarted since they landed answers 404 for them — and one rejection inside
  // that Promise.all takes out Agents, Models, Prompts, Providers and Tracing
  // as well, none of which have anything to do with the menu. Caught here, an
  // old engine costs exactly the tab it cannot serve, and that tab says so
  // rather than drawing an empty list that reads as "nothing is offered".
  private async readMenu() {
    try {
      [this.choices, this.routers] = await Promise.all([listModelChoices(), listRouters()]);
      this.menuProblem = "";
    } catch (e) {
      this.choices = [];
      this.routers = [];
      this.menuProblem = e instanceof Error ? e.message : String(e);
    }
  }

  // Every write goes through here: the list is re-read from the server rather
  // than patched in place, so what is on screen is what was stored.
  private async act(work: () => Promise<unknown>, then: View = { kind: "list" }) {
    this.problem = "";
    try {
      await work();
      await this.refresh();
      this.view = then;
    } catch (e) { this.problem = e instanceof Error ? e.message : String(e); }
  }

  private async probe(id: string) {
    this.probed = "testing…";
    try {
      const r = await testModel(id);
      this.probed = r.ok
        ? (r.reply !== undefined ? `answered: ${r.reply}` : `answered, ${r.dimensions} dimensions`)
        : `failed: ${r.error ?? "no reason given"}`;
    } catch (e) {
      this.probed = `failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private close() { this.view = { kind: "list" }; this.problem = ""; }

  // Editing a row edits a copy of it, so Cancel is dropping the copy.
  private open(view: View) { this.view = view; this.problem = ""; }

  private patch(fields: Record<string, unknown>) {
    const v = this.view;
    if (v.kind === "list") return;
    this.view = { ...v, row: { ...v.row, ...fields } } as View;
  }

  /* The same element, two frames.
     As an overlay it is something you opened over your conversation and will
     close again. As a page it is where you went — its own address, its own
     back button, a tab per URL, and room for forms that were cramped inside a
     centred card. Everything below the frame is identical, which is the point:
     one settings UI, and the page did not become a second copy that drifts. */
  render() {
    const body = html`
      <div class="body">
        <aside>
          <div class="label">${this.zone === "admin" ? "Deployment" : "Settings"}</div>
          ${TABS.filter((t) => t.zone === this.zone).map((t) => html`
            <div class="item ${t.name === this.tab ? "on" : ""}" data-tab=${t.name}
              @click=${() => this.goTab(t.name)}>
              <span class="ic"><nr-icon name=${t.icon} size="small"></nr-icon></span>
              <span>${t.name}</span>
            </div>`)}
        </aside>
        <main>
          ${this.renderTab()}
          ${this.problem === "" ? "" : html`<p class="err" role="alert">${this.problem}</p>`}
        </main>
      </div>`;
    if (this.page) { return body; }
    return html`
      <nr-overlay
        open
        label="Settings"
        allow-fullscreen
        @nr-close=${() => this.dispatchEvent(new CustomEvent("close"))}
      >
        ${body}
      </nr-overlay>
    `;
  }

  /* Choosing a tab. On a page it is a navigation — the URL is the tab, so the
     address bar, the back button and a pasted link all agree — and the
     history entry is replaced rather than pushed only for the tab the page
     opened on. In the overlay it is what it always was: state. */
  private goTab(name: Tab) {
    this.tab = name;
    this.close();
    if (!this.page) { return; }
    const slug = name.toLowerCase().replace(/ /g, "-");
    history.pushState({}, "", `/admin/${slug}`);
  }

  /* The person's own tab, absorbed from what was briefly a separate panel.
     One entry point for a person ("Settings"), whichever kind of setting they
     came for — the merge the user asked for by name. Theme is the whole of it
     today, plus who you are; it should grow slowly, because a row here that
     only an operator can act on is the mistake the zones exist to prevent.

     The head script in head.html owns resolving a choice into a palette —
     including "system", which keeps following the OS. This tab only writes
     the choice and rings the bell; repainting from here would be a second
     copy of that rule, and the two would disagree the first time either
     changed. */
  private preferencesTab() {
    const choices = [
      { id: "system" as const, label: "System", icon: "cpu" },
      { id: "light" as const, label: "Light", icon: "eye" },
      { id: "dark" as const, label: "Dark", icon: "circle" },
    ];
    const mail = this.me?.email ?? "";
    return html`
      ${this.head("Preferences", "settings")}

      ${this.group("Appearance")}
      <div class="seg" role="radiogroup" aria-label="Theme">
        ${choices.map((c) => html`
          <button class=${c.id === this.themeChoice ? "on" : ""} role="radio"
            aria-checked=${c.id === this.themeChoice ? "true" : "false"}
            @click=${() => this.chooseTheme(c.id)}>
            <nr-icon name=${c.icon} size="small"></nr-icon>${c.label}
          </button>`)}
      </div>
      <p class="note">System follows your device, and keeps following it if it
      changes while the console is open.</p>

      ${this.me === null ? "" : html`
        ${this.group("Account")}
        <div class="who">
          <span class="avatar">${(mail.trim()[0] ?? "?").toUpperCase()}</span>
          <span class="mail">${mail}</span>
        </div>
        <div class="bar">
          <button class="act" @click=${() => { location.assign("/logout"); }}>
            <nr-icon name="log-out" size="small"></nr-icon> Sign out</button>
        </div>`}

      ${!isAdmin(this.me) ? "" : html`
        ${this.group("Deployment")}
        <p class="note">Models, providers, images, MCP and tracing are how this
        deployment is wired, and they live on their own page.</p>
        <div class="bar">
          <button class="act" @click=${() => { location.assign("/admin/models"); }}>
            <nr-icon name="settings" size="small"></nr-icon> Open deployment settings</button>
        </div>`}
    `;
  }

  private chooseTheme(next: "system" | "light" | "dark") {
    this.themeChoice = next;
    try { localStorage.setItem("joule-theme", next); } catch { /* private mode */ }
    window.dispatchEvent(new Event("joule-theme"));
  }

  private renderTab() {
    // A tab from the other zone — a stale URL, a caller passing the old
    // default — falls to this zone's first tab rather than rendering a
    // surface the rail cannot show as selected.
    if (!TABS.some((t) => t.name === this.tab && t.zone === this.zone)) {
      this.tab = TABS.find((t) => t.zone === this.zone)?.name ?? "Agents";
    }
    switch (this.tab) {
      case "Preferences": return this.preferencesTab();
      case "Agents": return this.agentsTab();
      case "Models": return this.modelsTab();
      case "Model menu": return this.menuTab();
      case "Prompts": return this.promptsTab();
      case "Skills": return this.skillsTab();
      case "Templates": return this.templatesTab();
      case "MCP": return this.mcpTab();
      case "Connectors": return this.connectorsTab();
      case "Plugins": return this.pluginsTab();
      case "Images": return this.imagesTab();
      case "Providers": return this.providersTab();
      case "Sign-in": {
        const v = this.view;
        if (v.kind === "authp") { return this.authProviderForm(v.row, v.fresh); }
        return this.signInTab();
      }
      case "Tracing": return this.tracingTab();
    }
  }

  // --- the pieces every tab is built from ---------------------------------------------

  private head(title: string, icon: string) {
    return html`
      <div class="head">
        <span class="ic"><nr-icon name=${icon} size="small"></nr-icon></span>
        <h2>${title}</h2>
      </div>`;
  }

  // A count is shown when there is something to count. A group that is a
  // heading rather than a list — the tracing secret — would otherwise carry a
  // "0" that reads as a number that failed to load.
  private group(label: string, n?: number) {
    return html`
      <div class="group"><span class="label">${label}</span>
        ${n === undefined ? "" : html`<span class="n">${n}</span>`}</div>`;
  }

  private formHead(title: string) {
    return html`
      <div class="formhead">
        <button class="act" title="Back to the list" @click=${() => this.close()}>
          <nr-icon name="chevron-left" size="small"></nr-icon>
        </button>
        <h3>${title}</h3>
      </div>`;
  }

  private formActions(save: () => void, label = "Save") {
    return html`
      <div class="formacts">
        <button class="primary" @click=${save}>${label}</button>
        <button class="ghost" @click=${() => this.close()}>Cancel</button>
      </div>`;
  }

  // A field is described, not spelled out: one record per field rather than a
  // line of positional arguments nobody can read at the call site.
  private text(f: {
    id: string; label: string; value: string; on: (v: string) => void;
    required?: boolean; help?: string; placeholder?: string; type?: string;
    wide?: boolean; disabled?: boolean;
  }) {
    return html`
      <div class="f ${f.wide === true ? "wide" : ""}">
        <nr-input id=${f.id} .value=${f.value} type=${f.type ?? "text"}
          placeholder=${f.placeholder ?? ""} ?disabled=${f.disabled === true}
          @nr-input=${(e: Event) => f.on(valueOf(e))}
          @input=${(e: Event) => f.on(valueOf(e))}>
          <span slot="label">${f.label}${f.required === true ? html`<em class="req">*</em>` : ""}</span>
        </nr-input>
        ${f.help === undefined ? "" : html`<p class="help">${f.help}</p>`}
      </div>`;
  }

  private choice(f: {
    id: string; label: string; value: string; on: (v: string) => void;
    options: { value: string; label: string }[];
    required?: boolean; help?: string; wide?: boolean;
  }) {
    // An nr-dropdown rather than an nr-select, so every menu in this console is
    // the same object: the composer's + opens one of these, and a settings form
    // that opened something else made two components out of one idea.
    //
    // Three things nr-select did for free have to be done here, and each is a
    // line rather than a paragraph because the alternative is a select:
    //
    //  * The LABEL is beside the field, not slotted into it. nr-dropdown has no
    //    label slot — it is a menu, not a form control — so `.f > .label` (which
    //    the stylesheet already dresses identically to a slotted one) carries it.
    //  * The VALUE is drawn by the trigger. A dropdown does not know what is
    //    chosen; it emits a click and forgets. `chosen` resolves the stored
    //    value back to its label so the closed field still says what it is set
    //    to, and falls back to the raw value rather than to blank — a field
    //    pointing at a row that was deleted must not read as "nothing chosen".
    //  * The EVENT is the item, not a value. `nr-dropdown-item-click` carries
    //    `detail.item`, and the item's id is what was put in it below.
    //
    // The filter is the fourth, and it is a behaviour being kept rather than a
    // tidy-up. A blank-labelled option is how "nothing chosen" reaches these
    // forms — `withCurrent` appends the row's own value when it is not in the
    // list, and an unset one appends nothing readable. nr-select never drew
    // those; a dropdown draws every item it is given, so an unset tracing
    // backend put an empty, clickable row under the six real ones. Dropped
    // here rather than in `withCurrent`, which is also right about what it
    // does: the field is what decides how "unset" looks.
    //
    // Tested against `Boolean(label)` and not against `label !== ""`, which is
    // the version that did not work: an unset row reaches `withCurrent` as
    // undefined rather than as an empty string, so it is appended as an option
    // whose label is undefined — not equal to "", and drawn as a blank row all
    // the same.
    const chosen = f.options.find((o) => o.value === f.value);
    return html`
      <div class="f ${f.wide === true ? "wide" : ""}">
        <span class="label">${f.label}${f.required === true ? html`<em class="req">*</em>` : ""}</span>
        <nr-dropdown block class="pick" id=${f.id} trigger="click" placement="bottom-start" auto-close
          .items=${f.options.filter((o) => Boolean(o.label))
            .map((o) => ({ id: o.value, label: o.label }))}
          @nr-dropdown-item-click=${(e: CustomEvent<{ item: { id: string } }>) =>
            f.on(e.detail.item.id)}>
          <button slot="trigger" type="button" class="pick-face" aria-haspopup="listbox">
            <span class="pick-value">${chosen === undefined ? f.value : chosen.label}</span>
            <nr-icon name="chevron-down" size="small"></nr-icon>
          </button>
        </nr-dropdown>
        ${f.help === undefined ? "" : html`<p class="help">${f.help}</p>`}
      </div>`;
  }

  private area(f: {
    id: string; label: string; value: string; on: (v: string) => void;
    rows?: number; required?: boolean; help?: string; placeholder?: string;
  }) {
    return html`
      <div class="f wide">
        <!-- outlined: nr-textarea defaults to an underline while nr-input
             defaults to a box, so a form with both has one field that reads as
             a different kind of control. -->
        <nr-textarea variant="outlined" id=${f.id} .value=${f.value} rows=${f.rows ?? 6}
          placeholder=${f.placeholder ?? ""}
          @nr-input=${(e: Event) => f.on(valueOf(e))}
          @input=${(e: Event) => f.on(valueOf(e))}>
          <span slot="label">${f.label}${f.required === true ? html`<em class="req">*</em>` : ""}</span>
        </nr-textarea>
        ${f.help === undefined ? "" : html`<p class="help">${f.help}</p>`}
      </div>`;
  }

  // A prompt is written rather than filled in, so it gets an editor rather
  // than a box: monospace, its own scroll, and markdown highlighted as it is
  // typed — headings, lists, emphasis and fenced code all visible without
  // rendering anything. The component is CodeJar over a contenteditable, which
  // is why the value arrives on the event's detail: there is no <textarea>
  // underneath to read `.value` from.
  private editor(f: {
    id: string; label: string; value: string; on: (v: string) => void;
    language?: string; height?: string; required?: boolean; help?: string;
  }) {
    return html`
      <div class="f wide">
        <span class="label" id="${f.id}-label">
          ${f.label}${f.required === true ? html`<em class="req">*</em>` : ""}</span>
        <nr-code-editor
          id=${f.id}
          theme="vs"
          language=${f.language ?? "markdown"}
          word-wrap
          .code=${f.value}
          style=${`height:${f.height ?? "420px"}`}
          @nr-change=${(e: CustomEvent) => f.on((e.detail as { value: string }).value)}>
        </nr-code-editor>
        ${f.help === undefined ? "" : html`<p class="help">${f.help}</p>`}
      </div>`;
  }

  private check(f: {
    id: string; label: string; checked: boolean; on: (v: boolean) => void; help?: string;
  }) {
    return html`
      <div class="f check">
        <nr-checkbox id=${f.id} ?checked=${f.checked}
          @nr-change=${(e: CustomEvent) => f.on(e.detail.checked as boolean)}>${f.label}</nr-checkbox>
        ${f.help === undefined ? "" : html`<p class="help">${f.help}</p>`}
      </div>`;
  }

  private rowActions(items: { icon: string; title: string; danger?: boolean; run: () => void }[]) {
    return html`
      <td class="right"><span class="acts">
        ${items.map((i) => html`
          <button class="act ${i.danger === true ? "danger" : ""}" title=${i.title}
            @click=${i.run}><nr-icon name=${i.icon} size="small"></nr-icon></button>`)}
      </span></td>`;
  }

  // --- agents -------------------------------------------------------------------------

  private agentsTab() {
    const v = this.view;
    if (v.kind === "agent") return this.agentForm(v.row, v.fresh);
    const entry = this.agents.find((a) => a.isDefault);
    return html`
      ${this.head("Agents", "message-square")}
      <div class="bar">
        <button class="primary" data-new="agent"
          @click=${() => { this.skillDraft = []; this.open({ kind: "agent", row: { ...NEW_AGENT,
            modelConfigId: this.configs[0]?.id ?? "", promptId: this.prompts[0]?.id ?? "" },
            fresh: true }); }}>
          <nr-icon name="plus" size="small"></nr-icon> New agent
        </button>
      </div>

      ${this.group("General", this.agents.length)}
      <table><tbody>
        ${this.agents.map((a) => html`<tr>
          <td class="name">${a.agentName}</td>
          <td><span class="slug">${a.id}</span></td>
          <!-- What the agent is for. Dropped in the first pass of this table
               in favour of the id and the config, which is exactly backwards:
               those two are addresses, and this is the only column that says
               what the row does. -->
          <td class="fill dim"><span class="trunc">${a.description}</span></td>
          <td><span class="tag">${this.prompts.find((p) => p.id === a.promptId)?.promptName ?? a.promptId}</span></td>
          <td>${a.id === entry?.id ? html`<span class="tag live">entry</span>` : ""}
              ${a.enabled ? "" : html`<span class="tag off">off</span>`}</td>
          ${this.rowActions([
            { icon: "edit", title: `Edit ${a.agentName}`, run: () => {
              this.skillDraft = (a.skills ?? []).map((s) => s.id);
              this.open({ kind: "agent", row: { ...a }, fresh: false });
            } },
            { icon: "trash", title: `Delete ${a.agentName}`, danger: true,
              run: () => this.act(() => deleteAgent(a.id)) },
          ])}
        </tr>`)}
      </tbody></table>
      <p class="note">Changes take effect on the next message — no restart.</p>
    `;
  }

  private agentForm(a: AgentRow, fresh: boolean) {
    return html`
      ${this.formHead(fresh ? "New agent" : `Edit ${a.agentName}`)}
      <div class="banner">A change here is read by the next message of every
        conversation already open — there is no restart and no reconnect.</div>

      <div class="grid">
        ${this.text({ id: "a-name", label: "Name", value: a.agentName, required: true,
          placeholder: "What this agent is called", on: (v) => this.patch({ agentName: v }) })}
        ${this.text({ id: "a-id", label: "Id", value: a.id, required: true,
          disabled: !fresh, placeholder: "support-desk",
          help: fresh ? "Its address everywhere else — in the API, in a link, on the graph. It cannot be changed later."
                      : "An id is what other rows point at, so it is fixed once the row exists.",
          on: (v) => this.patch({ id: v }) })}
        ${this.text({ id: "a-desc", label: "Description", value: a.description, wide: true,
          placeholder: "What this agent is for", on: (v) => this.patch({ description: v }) })}
        ${this.choice({ id: "a-config", label: "Model configuration", value: a.modelConfigId,
          options: this.configs.map((c) => ({ value: c.id, label: `${c.id} · ${c.modelId}` })),
          required: true,
          help: "Which model answers, and the temperature and token budget it answers with.",
          on: (v) => this.patch({ modelConfigId: v }) })}
        ${this.choice({ id: "a-prompt", label: "Prompt", value: a.promptId,
          options: this.prompts.map((p) => ({ value: p.id, label: `${p.promptName} v${p.version}` })),
          required: true,
          help: "Prompts are versioned rather than edited; rolling back is pointing this at an older one.",
          on: (v) => this.patch({ promptId: v }) })}
        ${this.choice({ id: "a-image", label: "Script environment", value: a.scriptImageId,
          options: [{ value: "", label: "Deployment default" }].concat(
            this.images.filter((i) => i.enabled).map((i) => ({ value: i.id, label: `${i.label} · ${i.image}` }))),
          help: "The image this agent's script containers are built from. Its conversations inherit it when the container is created; changing it here affects the next one, not the ones already running.",
          on: (v) => this.patch({ scriptImageId: v }) })}
        ${this.check({ id: "a-enabled", label: "Enabled", checked: a.enabled,
          help: "A disabled agent keeps its rows and its history; it just cannot be opened.",
          on: (v) => this.patch({ enabled: v }) })}
        ${this.check({ id: "a-default", label: "Entry agent", checked: a.isDefault,
          help: "The agent a new conversation opens against. Exactly one, so turning this on turns another off.",
          on: (v) => this.patch({ isDefault: v }) })}
      </div>

      ${this.skills.length === 0 ? "" : html`
        ${this.group("Skills", this.skillDraft.length)}
        <div class="grid">
          ${this.skills.map((k) => this.check({
            id: `a-skill-${k.skillName}`, label: k.skillName,
            checked: this.skillDraft.includes(k.id),
            help: k.description,
            on: (on) => { this.skillDraft = on
              ? [...this.skillDraft.filter((x) => x !== k.id), k.id]
              : this.skillDraft.filter((x) => x !== k.id); } }))}
        </div>
      `}

      ${this.formActions(() => this.act(async () => {
        // The row first — a fresh agent needs to exist before a link can name
        // it — then the checklist's diff against what was stored.
        if (fresh) { await createAgent(a); } else { await updateAgent(a); }
        const before = fresh ? [] : (this.agents.find((x) => x.id === a.id)?.skills ?? []).map((s) => s.id);
        for (const id of this.skillDraft.filter((x) => !before.includes(x))) { await linkSkill(a.id, id); }
        for (const id of before.filter((x) => !this.skillDraft.includes(x))) { await unlinkSkill(a.id, id); }
      }))}
    `;
  }

  // --- models and their configurations ------------------------------------------------

  private modelsTab() {
    const v = this.view;
    if (v.kind === "model") return this.modelForm(v.row, v.fresh);
    if (v.kind === "config") return this.configForm(v.row, v.fresh);

    const chat = this.models.filter((m) => m.kind !== "embedding");
    const embedding = this.models.filter((m) => m.kind === "embedding");
    return html`
      ${this.head("Models", "zap")}
      <div class="bar">
        <button class="ghost" data-new="config"
          @click=${() => this.open({ kind: "config", fresh: true, row: { ...NEW_CONFIG,
            modelId: this.models.find((m) => m.kind !== "embedding")?.id ?? "" } })}>
          <nr-icon name="settings" size="small"></nr-icon> New configuration
        </button>
        <button class="primary" data-new="model"
          @click=${() => this.open({ kind: "model", row: { ...NEW_MODEL }, fresh: true })}>
          <nr-icon name="plus" size="small"></nr-icon> New model
        </button>
      </div>

      ${this.group("Generation", chat.length)}
      <table><tbody>${chat.map((m) => this.modelRow(m))}</tbody></table>

      ${this.group("Embedding", embedding.length)}
      <table><tbody>${embedding.map((m) => this.modelRow(m))}</tbody></table>
      <p class="note">One embedding model is active at a time, and turning one on turns
      the others off — documents embedded by different models cannot see each other, so a
      second active embedder splits the corpus with nothing to report it.</p>

      ${this.group("Configurations", this.configs.length)}
      <table><tbody>
        ${this.configs.map((c) => html`<tr>
          <td class="name">${c.label === "" ? c.id : c.label}</td>
          <td><span class="slug">${c.id}</span></td>
          <td><span class="slug">${c.modelId}</span></td>
          <!-- Concatenated rather than interpolated: a nested template literal
               inside an html literal is legal, and is also the shape that has
               ended one by accident four times in this app. -->
          <td class="fill dim">temperature ${c.temperature} · ${c.maxTokens} max tokens · top-p ${c.topP}
            ${c.thinking === "" ? "" : " · thinking " + c.thinking}</td>
          <td>${c.selectable ? html`<span class="tag">offered</span>` : ""}</td>
          ${this.rowActions([
            { icon: "edit", title: `Edit ${c.id}`,
              run: () => this.open({ kind: "config", row: { ...c }, fresh: false }) },
            { icon: "trash", title: `Delete ${c.id}`, danger: true,
              run: () => this.act(() => deleteConfig(c.id)) },
          ])}
        </tr>`)}
      </tbody></table>
      <p class="note">An agent mid-conversation reads its configuration every round, so an edit
      here lands on the next message. The id is fixed: everything that names this row —
      an agent, a menu entry, a router candidate — names it by that.</p>

      ${this.probed === "" ? "" : html`<p class="said">${this.probed}</p>`}
    `;
  }

  private modelRow(m: ModelRow) {
    return html`<tr>
      <td class="name">${m.label}</td>
      <td><span class="tag">${m.provider}</span></td>
      <td><span class="slug">${m.apiName}</span></td>
      <td class="fill dim">${m.baseUrl === "" ? "" : m.baseUrl}
        ${m.kind === "embedding" && m.dimensions > 0 ? `${m.dimensions} dimensions` : ""}</td>
      <td>${m.enabled ? html`<span class="tag live">on</span>` : html`<span class="tag off">off</span>`}</td>
      ${this.rowActions([
        { icon: "play", title: `Test ${m.label}`, run: () => this.probe(m.id) },
        { icon: "edit", title: `Edit ${m.label}`, run: () => this.open({ kind: "model", row: { ...m }, fresh: false }) },
        { icon: "trash", title: `Delete ${m.label}`, danger: true, run: () => this.act(() => deleteModel(m.id)) },
      ])}
    </tr>`;
  }

  private modelForm(m: ModelRow, fresh: boolean) {
    const embedding = m.kind === "embedding";
    return html`
      ${this.formHead(fresh ? "New model" : `Edit ${m.label}`)}
      <div class="grid">
        ${this.text({ id: "m-label", label: "Name", value: m.label, required: true,
          placeholder: "What to call it here", on: (v) => this.patch({ label: v }) })}
        ${this.text({ id: "m-id", label: "Id", value: m.id, required: true, disabled: !fresh,
          placeholder: "mistral-small", on: (v) => this.patch({ id: v }) })}
        ${this.choice({ id: "m-provider", label: "Provider", value: m.provider, required: true,
          options: withCurrent(PROVIDERS, m.provider), on: (v) => this.patch({ provider: v }) })}
        ${this.text({ id: "m-apiname", label: "Model identifier", value: m.apiName, required: true,
          placeholder: "mistral-small-latest",
          help: "The name the provider itself knows it by.",
          on: (v) => this.patch({ apiName: v }) })}
        ${this.text({ id: "m-baseurl", label: "Base URL", value: m.baseUrl, wide: true,
          placeholder: "https://api.groq.com/openai/v1",
          help: "Blank for the provider's own address; fill it in for an OpenAI-compatible host — a gateway, a proxy, Ollama.",
          on: (v) => this.patch({ baseUrl: v }) })}
        ${this.choice({ id: "m-kind", label: "Kind", value: m.kind,
          options: options(["chat", "embedding"]),
          on: (v) => this.patch({ kind: v }) })}
        ${embedding ? this.text({ id: "m-dimensions", label: "Dimensions", type: "number",
          value: String(m.dimensions), required: true, placeholder: "1024",
          help: "How wide this model's vectors are — 1024 for mistral-embed. A width that does not match builds a column the provider's own answers will not fit.",
          on: (v) => this.patch({ dimensions: parseInt(v || "0", 10) }) }) : ""}
        ${this.check({ id: "m-enabled", label: "Enabled", checked: m.enabled,
          help: embedding
            ? "One embedding model is active at a time: turning this on turns the others off."
            : "Only an enabled model can be named by a configuration.",
          on: (v) => this.patch({ enabled: v }) })}
      </div>
      ${this.formActions(() => this.act(() => fresh ? createModel(m) : updateModel(m)))}
    `;
  }

  private configForm(c: ModelConfigRow, fresh: boolean) {
    return html`
      ${this.formHead(fresh ? "New configuration" : `Edit ${c.label === "" ? c.id : c.label}`)}
      <div class="banner">A configuration is how an agent names a model: the id here is
        what its <em>Model configuration</em> field points at. It is also the unit the
        composer's menu is built from — the same model at two thinking budgets is two
        configurations, which is what makes Instant and Thinking two entries.</div>
      <div class="grid">
        ${this.text({ id: "c-id", label: "Id", value: c.id, required: true, disabled: !fresh,
          placeholder: "mistral-big", on: (v) => this.patch({ id: v }) })}
        ${this.text({ id: "c-label", label: "Name", value: c.label,
          placeholder: "Thinking",
          help: "What this row is called where somebody picks it. The model's own name cannot serve: two configurations over one model would arrive in a list as the same word twice.",
          on: (v) => this.patch({ label: v }) })}
        ${this.choice({ id: "c-model", label: "Model", value: c.modelId, required: true,
          options: this.models.map((m) => ({ value: m.id, label: `${m.label} · ${m.apiName}` })),
          on: (v) => this.patch({ modelId: v }) })}
        ${this.text({ id: "c-maxtokens", label: "Max tokens", type: "number",
          value: String(c.maxTokens), required: true, placeholder: "8192",
          help: "The ceiling on one reply. A model that reaches it while writing a tool call stops mid-call, and a reply cut off there cannot be stored — so a budget too small for the work is felt as a conversation that stops answering.",
          on: (v) => this.patch({ maxTokens: parseInt(v || "0", 10) }) })}
        ${this.text({ id: "c-temperature", label: "Temperature", type: "number",
          value: String(c.temperature), placeholder: "0.2",
          help: "0 for work that must be repeatable, higher for prose.",
          on: (v) => this.patch({ temperature: Number(v || "0") }) })}
        ${this.text({ id: "c-topp", label: "Top-p", type: "number", value: String(c.topP),
          placeholder: "1", on: (v) => this.patch({ topP: Number(v || "0") }) })}
        ${this.text({ id: "c-thinking", label: "Thinking", value: c.thinking,
          placeholder: "medium, or 8192",
          help: "How hard to think before answering, where the provider takes an instruction: a token budget for Anthropic, an effort — low, medium, high — for the reasoning models. Blank is however it normally answers.",
          on: (v) => this.patch({ thinking: v }) })}
        ${this.area({ id: "c-extra", label: "Extra", value: c.extra, rows: 3,
          placeholder: "{}",
          help: "Sent to the provider as-is, for the fields this form does not carry.",
          on: (v) => this.patch({ extra: v }) })}
        ${this.check({ id: "c-selectable", label: "Offer this configuration", checked: c.selectable,
          help: "Whether it appears where a person picks a configuration. Not the composer's menu — that is Model menu, curated one entry at a time.",
          on: (v) => this.patch({ selectable: v }) })}
      </div>
      ${this.formActions(() => this.act(() => fresh ? createConfig(c) : updateConfig(c)),
        fresh ? "Create" : "Save")}
    `;
  }

  // --- the model menu, and the router behind its Auto row -----------------------------
  //
  // Two lists on one page, because they are one feature: the menu is what a
  // person opens beside the composer, and a router is what one of its rows
  // does. Splitting them across tabs would put the thing being configured and
  // the thing it points at in different rooms.

  // The configurations a menu entry or a router candidate may name. Embedding
  // configurations are excluded here rather than only refused on save: an
  // embedding model in a picker is an option somebody chooses and then gets a
  // provider's refusal from, per turn, until an operator reads a log.
  private chatConfigs(): ModelConfigRow[] {
    return this.configs.filter((c) =>
      this.models.some((m) => m.id === c.modelId && m.kind === "chat"));
  }

  // A configuration as a person should read it: what it is called, and which
  // model is underneath. Falls back to the id, which is the only thing that is
  // certainly there.
  private configName(id: string): string {
    const c = this.configs.find((x) => x.id === id);
    if (c === undefined) { return id; }
    const m = this.models.find((x) => x.id === c.modelId);
    const name = c.label === "" ? c.id : c.label;
    return m === undefined ? name : `${name} · ${m.label}`;
  }

  // The chat configurations, plus whatever the row already points at. A router
  // whose candidate was pointed at a configuration that has since been deleted
  // still shows what it actually says, rather than being silently redrawn as
  // the first option that happens to fit.
  private configOptions(current: string) {
    const list = this.chatConfigs().map((c) => ({ value: c.id, label: this.configName(c.id) }));
    if (current !== "" && !list.some((o) => o.value === current)) {
      return [...list, { value: current, label: `${current} — no such configuration` }];
    }
    return list;
  }

  private menuTab() {
    const v = this.view;
    if (v.kind === "choice") return this.choiceForm(v.row, v.fresh);
    if (v.kind === "router") return this.routerForm(v.row, v.fresh);

    // An engine that cannot answer for the menu cannot be written to either,
    // so the actions are not drawn. An empty list here would read as "nothing
    // is offered", which is a different and much more alarming sentence.
    if (this.menuProblem !== "") {
      return html`
        ${this.head("Model menu", "list")}
        <div class="banner">The engine did not answer for the menu:
          <strong>${this.menuProblem}</strong>. These routes are newer than the rest of
          this page — an engine that has not been restarted since they landed does not
          serve them, and nothing about the menu can be read or written until it has.</div>`;
    }

    const entry = this.agents.find((a) => a.isDefault);
    const fallbackName = entry === undefined ? "" : this.configName(entry.modelConfigId);
    const automatic = this.choices.some((c) => c.kind === "router" && c.enabled);
    const first = this.chatConfigs()[0]?.id ?? "";
    return html`
      ${this.head("Model menu", "list")}
      <div class="bar">
        <button class="ghost" data-new="router"
          @click=${() => this.open({ kind: "router", fresh: true, row: { ...NEW_ROUTER,
            routerConfigId: first, fallbackConfigId: first, candidates: [] } })}>
          <nr-icon name="shuffle" size="small"></nr-icon> New router
        </button>
        <button class="primary" data-new="choice"
          @click=${() => this.open({ kind: "choice", fresh: true, row: { ...NEW_CHOICE,
            configId: first, rank: this.choices.length + 1 } })}>
          <nr-icon name="plus" size="small"></nr-icon> New entry
        </button>
      </div>

      <div class="banner">This is the menu beside the composer, in this order and in these
        words. A conversation with nothing chosen runs on its agent's own model, which is
        what every conversation opened before this list existed still means.</div>

      ${this.group("Menu", this.choices.length)}
      ${this.choices.length === 0
        ? html`<p class="empty">Nothing is offered, so the composer shows no picker at all —
            which is the right answer for a deployment with one model and the wrong one for
            this deployment as soon as there are two.</p>`
        : html`<table><tbody>
            ${this.choices.map((c, i) => this.choiceRow(c, i))}
            <!-- The last line of the real menu, which is not a row of this table
                 and never can be: it is how a person goes back to the agent's own
                 model. Shown so this page is the same length as the menu it edits. -->
            <tr class="tail"><td class="ord"></td>
              <td colspan="4">${fallbackName === "" ? "Agent default" : "Agent default (" + fallbackName + ")"}</td>
            </tr>
          </tbody></table>`}

      ${automatic ? html`<p class="note">One of these entries is automatic, so every message
        sent under it costs one extra completion — a small model reads the message and picks.
        Tens to low hundreds of milliseconds against a turn that takes seconds, and a token
        bill that is small rather than absent.</p>` : ""}
      <p class="note">Taking something off the menu is <em>On the menu</em>, not Delete: an
      entry conversations are still set to is refused a delete, and turning it off leaves
      those conversations running on what they already chose.</p>

      ${this.group("Routers", this.routers.length)}
      ${this.routers.length === 0
        ? html`<p class="empty">No router. One is worth having when there are at least two
            models worth choosing between — with one candidate the routing call can only
            return one answer.</p>`
        : html`<table><tbody>
            ${this.routers.map((r) => this.routerRow(r))}
          </tbody></table>`}
      <p class="note">A router is not itself on the menu — a menu entry of kind
      <em>automatic</em> points at one, and that entry is what a person picks.</p>
    `;
  }

  private choiceRow(c: ModelChoiceRow, i: number) {
    const target = c.kind === "router"
      ? (this.routers.find((r) => r.id === c.routerId)?.label ?? `${c.routerId} — no such router`)
      : this.configName(c.configId);
    return html`<tr>
      <td class="ord"><span class="acts">
        <button class="act" title="Move up" ?disabled=${i === 0}
          @click=${() => this.moveChoice(i, -1)}>
          <nr-icon name="arrow-up" size="small"></nr-icon></button>
        <button class="act" title="Move down" ?disabled=${i === this.choices.length - 1}
          @click=${() => this.moveChoice(i, 1)}>
          <nr-icon name="arrow-down" size="small"></nr-icon></button>
      </span></td>
      <td class="fill">
        <span class="menuname">
          <!-- The two marks the composer's own menu draws, for the same two
               reasons: an automatic row decides per message which model
               answers, and a premium row is priced. Neither is a lock; the
               diamond in particular says priced where a padlock would say
               forbidden, which nothing here enforces. -->
          ${c.kind === "router" ? html`<nr-icon name="shuffle" size="small"></nr-icon>` : ""}
          <span>${c.label}</span>
          ${c.tier === "premium"
            ? html`<nr-icon name="diamond" size="small" title="Premium"></nr-icon>` : ""}
        </span>
        ${c.description === "" ? "" : html`<span class="sub">${c.description}</span>`}
      </td>
      <td><span class="slug">${target}</span></td>
      <td>${c.enabled ? "" : html`<span class="tag off">off</span>`}</td>
      ${this.rowActions([
        { icon: "edit", title: `Edit ${c.label}`,
          run: () => this.open({ kind: "choice", row: { ...c }, fresh: false }) },
        { icon: "trash", title: `Delete ${c.label}`, danger: true,
          run: () => this.act(() => deleteModelChoice(c.id)) },
      ])}
    </tr>`;
  }

  private routerRow(r: ModelRouterRow) {
    const named = this.choices.filter((c) => c.routerId === r.id).length;
    return html`<tr>
      <td class="name">${r.label}</td>
      <td><span class="slug">${r.id}</span></td>
      <td class="fill dim">${r.candidates.length} candidate${r.candidates.length === 1 ? "" : "s"}
        · decided by ${this.configName(r.routerConfigId)}</td>
      <td><span class="tag">${r.routeEvery === "thread" ? "once per conversation" : "every message"}</span></td>
      <td>${r.escalateOnly ? html`<span class="tag">escalate only</span>` : ""}
          ${r.enabled ? "" : html`<span class="tag off">off</span>`}
          ${named === 0 ? html`<span class="tag">not on the menu</span>` : ""}</td>
      ${this.rowActions([
        { icon: "edit", title: `Edit ${r.label}`,
          run: () => this.open({ kind: "router", row: { ...r, candidates: [...r.candidates] },
            fresh: false }) },
        { icon: "trash", title: `Delete ${r.label}`, danger: true,
          run: () => this.act(() => deleteRouter(r.id)) },
      ])}
    </tr>`;
  }

  // A move renumbers the whole list from 1 and writes only the rows whose rank
  // actually changed.
  //
  // Renumbering rather than swapping two numbers, because rank ties are real:
  // the seed writes rows this list has never been reordered by hand, and the
  // engine breaks a tie by label — so swapping the ranks of two rows that both
  // hold 0 moves nothing and the arrow looks broken. Only the changed rows are
  // written, and each write is the rank alone, so a reorder never carries some
  // other field back over a row nobody opened.
  private moveChoice(i: number, delta: number) {
    const to = i + delta;
    if (to < 0 || to >= this.choices.length) { return; }
    const order = [...this.choices];
    const moved = order[i];
    order[i] = order[to];
    order[to] = moved;
    void this.act(async () => {
      for (let k = 0; k < order.length; k += 1) {
        if (order[k].rank !== k + 1) { await rankChoice(order[k].id, k + 1); }
      }
    });
  }

  private choiceForm(c: ModelChoiceRow, fresh: boolean) {
    const automatic = c.kind === "router";
    return html`
      ${this.formHead(fresh ? "New menu entry" : `Edit ${c.label}`)}
      <div class="banner">The label and the line under it are shown to whoever opens the
        picker, exactly as they are typed here. Write them for the moment of choosing:
        the description is the only thing that says what this entry is for.</div>

      <div class="grid">
        ${this.text({ id: "ch-label", label: "Label", value: c.label, required: true,
          placeholder: "Thinking",
          help: "The word in the menu.", on: (v) => this.patch({ label: v }) })}
        ${this.text({ id: "ch-id", label: "Id", value: c.id, required: true, disabled: !fresh,
          placeholder: "ch-thinking",
          help: fresh
            ? "What a conversation stores when somebody picks this. It cannot be changed later."
            : "Conversations already point at this id, so it is fixed once the row exists.",
          on: (v) => this.patch({ id: v }) })}
        ${this.text({ id: "ch-desc", label: "Description", value: c.description, wide: true,
          placeholder: "Slower, and reasons before it answers",
          help: "The one line under the label in the menu.",
          on: (v) => this.patch({ description: v }) })}
        ${this.choice({ id: "ch-kind", label: "What it runs", value: c.kind, required: true,
          options: [
            { value: "config", label: "A fixed model configuration" },
            { value: "router", label: "Automatic — a router picks per message" },
          ],
          help: "An automatic entry is the menu's Auto: before each message a small model reads it and chooses one of the router's candidates. That is one extra completion per message.",
          // Both ids are never set at once: the engine refuses a row carrying
          // the one its kind does not use, and this is the field that decides
          // which that is.
          on: (v) => this.patch({
            kind: v,
            configId: v === "config" ? c.configId : "",
            routerId: v === "router" ? c.routerId : "",
          }) })}
        ${automatic
          ? this.choice({ id: "ch-router", label: "Router", value: c.routerId, required: true,
              options: this.routers.map((r) => ({ value: r.id, label: r.label })),
              help: this.routers.length === 0
                ? "There is no router yet — make one first, on this page."
                : "Which router decides. Its candidates and their route descriptions are edited under Routers.",
              on: (v) => this.patch({ routerId: v }) })
          : this.choice({ id: "ch-config", label: "Model configuration", value: c.configId,
              required: true, options: this.configOptions(c.configId),
              help: "Which configuration answers when this entry is picked.",
              on: (v) => this.patch({ configId: v }) })}
        <!-- The stored value for a standard row is the empty string, and an
             empty value is what nr-select reads as nothing chosen: the field
             drew "Select an option" over a row that was perfectly well set. So
             the control carries a word and the wire keeps its empty string. -->
        ${this.choice({ id: "ch-tier", label: "Tier",
          value: c.tier === "premium" ? "premium" : "standard",
          options: [
            { value: "standard", label: "Standard" },
            { value: "premium", label: "Premium" },
          ],
          help: "A mark on the row, never a refusal: the menu draws a diamond and nothing here enforces anything.",
          on: (v) => this.patch({ tier: v === "premium" ? "premium" : "" }) })}
        ${this.check({ id: "ch-enabled", label: "On the menu", checked: c.enabled,
          help: "A disabled entry keeps its row and keeps working for conversations already set to it; it is simply not offered any more.",
          on: (v) => this.patch({ enabled: v }) })}
      </div>
      ${this.formActions(() => this.act(() => fresh ? createModelChoice(c) : updateModelChoice(c)),
        fresh ? "Create" : "Save")}
    `;
  }

  // --- the router editor ---------------------------------------------------------------

  // A key for a newly picked candidate: readable, and unique without regard to
  // case — the router folds case when it matches a reply against these keys, so
  // "fast" and "Fast" are one key and which of them a reply selects would be
  // nobody's decision.
  private candidateKey(taken: RouterCandidate[], c: ModelConfigRow): string {
    const from = c.label === "" ? c.id : c.label;
    const stem = from.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const base = stem === "" ? "option" : stem;
    let key = base;
    let n = 2;
    while (taken.some((k) => k.key.toLowerCase() === key)) { key = `${base}-${n}`; n += 1; }
    return key;
  }

  private patchCandidates(list: RouterCandidate[]) {
    this.patch({ candidates: list });
  }

  private moveCandidate(r: ModelRouterRow, i: number, delta: number) {
    const to = i + delta;
    if (to < 0 || to >= r.candidates.length) { return; }
    const list = [...r.candidates];
    const moved = list[i];
    list[i] = list[to];
    list[to] = moved;
    this.patchCandidates(list);
  }

  private routerForm(r: ModelRouterRow, fresh: boolean) {
    const chat = this.chatConfigs();
    const chosen = (id: string) => r.candidates.some((k) => k.configId === id);
    return html`
      ${this.formHead(fresh ? "New router" : `Edit ${r.label}`)}
      <div class="banner">A router is what the menu's automatic entry does. Before each
        message a small, cheap model is shown the candidates below — their keys and the
        descriptions written for them — and answers with one key; that candidate answers the
        message. <strong>It costs one extra completion per message</strong>, which is tens to
        low hundreds of milliseconds and a token bill that is small rather than absent. Every
        failure — an unknown answer, a provider error, a deleted configuration — lands on the
        fallback, so a message that would have been answered is always answered.</div>

      <div class="grid">
        ${this.text({ id: "rt-label", label: "Label", value: r.label, required: true,
          placeholder: "Auto",
          help: "What this router is called here. What a person sees is the menu entry's own label.",
          on: (v) => this.patch({ label: v }) })}
        ${this.text({ id: "rt-id", label: "Id", value: r.id, required: true, disabled: !fresh,
          placeholder: "rt-auto",
          help: fresh ? "What a menu entry points at. It cannot be changed later."
                      : "A menu entry points at this id, so it is fixed once the row exists.",
          on: (v) => this.patch({ id: v }) })}
      </div>

      ${this.group("Candidates", r.candidates.length)}
      <p class="note">Pick what this router may choose between, then say when each one should
      be chosen. Those descriptions are the whole interface to the decision — the routing
      model is given them and the message, and nothing else about what these models are, so
      write about the kind of message rather than about the model, and write so the lines
      differ from each other. The key is the word the routing model answers with: it is
      matched as exact membership of this list and never parsed, which is also what contains
      a message trying to talk its way onto a more expensive model — the worst it can reach
      is another candidate you approved. Order is priority, and it is the direction
      <em>escalate only</em> below allows: put them in increasing order of effort.</p>

      ${chat.length === 0
        ? html`<p class="empty">There is no chat configuration to route to. Make one under
            Models first.</p>`
        : html`<div class="grid">
            ${chat.map((c) => this.check({
              id: `rt-pick-${c.id}`, label: this.configName(c.id), checked: chosen(c.id),
              on: (on) => this.patchCandidates(on
                ? [...r.candidates, { key: this.candidateKey(r.candidates, c), configId: c.id, when: "" }]
                : r.candidates.filter((k) => k.configId !== c.id)) }))}
          </div>`}

      ${r.candidates.length === 0
        ? html`<p class="empty">Nothing picked yet. A router with no candidate has nothing to
            choose and every message falls through to the fallback.</p>`
        : ""}

      ${r.candidates.map((k, i) => html`
        <div class="cand">
          <div class="top">
            <span class="n">${i + 1}</span>
            <span class="who">${this.configName(k.configId)}</span>
            <button class="act" title="Higher priority" ?disabled=${i === 0}
              @click=${() => this.moveCandidate(r, i, -1)}>
              <nr-icon name="arrow-up" size="small"></nr-icon></button>
            <button class="act" title="Lower priority" ?disabled=${i === r.candidates.length - 1}
              @click=${() => this.moveCandidate(r, i, 1)}>
              <nr-icon name="arrow-down" size="small"></nr-icon></button>
            <button class="act danger" title="Remove this candidate"
              @click=${() => this.patchCandidates(r.candidates.filter((_, j) => j !== i))}>
              <nr-icon name="trash" size="small"></nr-icon></button>
          </div>
          <div class="grid">
            <!-- Neither field carries help text, though both would earn one on
                 their own: there are as many of these cards as there are
                 candidates, and the same two paragraphs repeated three times
                 push the thing being written off the screen. Both are said once,
                 above the cards. -->
            ${this.text({ id: `rt-key-${i}`, label: "Key", value: k.key, required: true,
              placeholder: "fast",
              on: (v) => this.patchCandidates(
                r.candidates.map((x, j) => j === i ? { ...x, key: v } : x)) })}
            ${this.area({ id: `rt-when-${i}`, label: "Choose this when", value: k.when,
              rows: 4, required: true,
              placeholder: "greetings, short factual questions, edits to text already in the conversation",
              on: (v) => this.patchCandidates(
                r.candidates.map((x, j) => j === i ? { ...x, when: v } : x)) })}
          </div>
        </div>`)}

      ${this.group("The decision")}
      <div class="grid">
        ${this.choice({ id: "rt-config", label: "Routing model", value: r.routerConfigId,
          required: true, options: this.configOptions(r.routerConfigId),
          help: "The configuration that makes the choice — small, fast and cheap, because it runs before every message. Its own token budget is capped by the engine, so a chatty model cannot answer the routing prompt with an essay.",
          on: (v) => this.patch({ routerConfigId: v }) })}
        ${this.choice({ id: "rt-fallback", label: "Fallback", value: r.fallbackConfigId,
          required: true, options: this.configOptions(r.fallbackConfigId),
          help: "What answers when the routing call fails, times out, or names something that is not a key above. A run that would have happened still happens.",
          on: (v) => this.patch({ fallbackConfigId: v }) })}
        ${this.choice({ id: "rt-every", label: "Decide", value: r.routeEvery,
          options: [
            { value: "turn", label: "Every message" },
            { value: "thread", label: "Once per conversation" },
          ],
          help: "Every message is one extra completion per message, and follows a conversation as it changes subject. Once per conversation pays for the decision a single time and keeps it — cheaper, and wrong for a conversation that starts with hello and ends with a plan.",
          on: (v) => this.patch({ routeEvery: v }) })}
        ${this.check({ id: "rt-escalate", label: "Escalate only", checked: r.escalateOnly,
          help: "A ratchet within one conversation: once a message has been routed to a candidate, no later message in that conversation is routed to one ABOVE it in the list — the router can go further down, never back up. It is for the follow-up that reads as trivial. Ask something hard, get a careful answer, then ask for it shorter: on its own that routes to the fast model and produces something visibly worse than the answer it is editing.",
          on: (v) => this.patch({ escalateOnly: v }) })}
        ${this.check({ id: "rt-enabled", label: "Enabled", checked: r.enabled,
          help: "A disabled router routes nothing; a menu entry pointing at it answers on the agent's own model.",
          on: (v) => this.patch({ enabled: v }) })}
      </div>

      ${this.formActions(() => this.act(() => fresh ? createRouter(r) : updateRouter(r)),
        fresh ? "Create" : "Save")}
    `;
  }

  // --- prompts ------------------------------------------------------------------------

  // The images an operator will run scripts in.
  //
  // Curated here rather than named by a model: run_script builds a
  // conversation's container from its agent's choice, and a model that could
  // name its own image could make the server pull anything off the internet
  // and run it.
  private imagesTab() {
    const v = this.view;
    if (v.kind === "image") return this.imageForm(v.row);
    return html`
      ${this.head("Images", "box")}
      <div class="bar">
        <button class="primary" data-new="image"
          @click=${() => this.open({ kind: "image",
            row: { id: "", label: "", image: "", enabled: true } })}>
          <nr-icon name="plus" size="small"></nr-icon> New image
        </button>
      </div>

      ${this.group("Images", this.images.length)}
      <table><tbody>
        ${this.images.map((i) => html`<tr>
          <td class="name">${i.label}</td>
          <td class="fill dim"><span class="trunc">${i.image}</span></td>
          <td><span class="tag">${i.enabled ? "enabled" : "off"}</span></td>
          ${this.rowActions([
            { icon: "edit", title: `Edit ${i.label}`,
              run: () => this.open({ kind: "image", row: { ...i } }) },
            { icon: "trash-2", title: `Delete ${i.label}`, danger: true,
              run: () => { void this.removeImage(i.id); } },
          ])}
        </tr>`)}
      </tbody></table>
      <p class="note">An agent picks one of these; its conversations inherit it when their
      container is created. Deleting one leaves those agents on the deployment default rather
      than breaking them.</p>
    `;
  }

  private imageForm(row: ScriptImageRow) {
    const fresh = !this.images.some((i) => i.id === row.id);
    return html`
      ${this.head(fresh ? "New image" : row.label, "box")}
      <div class="form">
        ${this.text({ id: "i-label", label: "Label", value: row.label, required: true,
          placeholder: "Python + node toolchain", on: (v) => this.patch({ label: v }) })}
        ${this.text({ id: "i-id", label: "Id", value: row.id, required: true, disabled: !fresh,
          placeholder: "runtime-1", on: (v) => this.patch({ id: v }) })}
        ${this.text({ id: "i-image", label: "Image reference", value: row.image, required: true,
          wide: true, placeholder: "agents-runtime:1",
          help: "What docker is handed. A tag or a digest; it must already be present on the host or pullable by it.",
          on: (v) => this.patch({ image: v }) })}
        ${this.check({ id: "i-enabled", label: "Enabled", checked: row.enabled,
          help: "A disabled image stays configured but is not offered to an agent.",
          on: (v) => this.patch({ enabled: v }) })}
      </div>
      ${this.formActions(() => { void this.saveImage(row, fresh); })}
    `;
  }

  private async saveImage(row: ScriptImageRow, fresh: boolean) {
    this.problem = "";
    try {
      if (fresh) { await createScriptImage(row); } else { await updateScriptImage(row); }
      this.view = { kind: "list" };
      await this.refresh();
    } catch (e) {
      this.problem = e instanceof Error ? e.message : String(e);
    }
  }

  private async removeImage(id: string) {
    this.problem = "";
    try {
      await deleteScriptImage(id);
      await this.refresh();
    } catch (e) {
      this.problem = e instanceof Error ? e.message : String(e);
    }
  }

  private promptsTab() {
    const v = this.view;
    if (v.kind === "prompt") return this.promptForm(v.row);
    return html`
      ${this.head("Prompts", "file-text")}
      <div class="bar">
        <button class="primary" data-new="prompt"
          @click=${() => this.open({ kind: "prompt", row: { promptName: "", body: "" } })}>
          <nr-icon name="plus" size="small"></nr-icon> New prompt
        </button>
      </div>

      ${this.group("Versions", this.prompts.length)}
      <table><tbody>
        ${this.prompts.map((p) => html`<tr>
          <td class="name">${p.promptName}</td>
          <td><span class="tag">v${p.version}</span></td>
          <td class="fill dim"><span class="trunc">${p.body}</span></td>
          ${this.rowActions([
            { icon: "plus", title: `New version of ${p.promptName}`,
              run: () => this.open({ kind: "prompt", row: { promptName: p.promptName, body: p.body } }) },
          ])}
        </tr>`)}
      </tbody></table>
      <p class="note">Prompts are never edited — a change is a new version, and rollback is
      pointing an agent at an older one.</p>
    `;
  }

  private promptForm(p: { promptName: string; body: string }) {
    const prior = this.prompts.filter((x) => x.promptName === p.promptName);
    const next = prior.length === 0 ? 1 : Math.max(...prior.map((x) => x.version)) + 1;
    return html`
      ${this.formHead(prior.length === 0 ? "New prompt" : `${p.promptName} · version ${next}`)}
      <div class="grid">
        ${this.text({ id: "p-name", label: "Name", value: p.promptName, required: true,
          placeholder: "support-desk",
          help: "A name that already exists gets the next version rather than replacing one.",
          on: (v) => this.patch({ promptName: v }) })}
        ${this.editor({ id: "p-body", label: "Prompt", value: p.body, required: true,
          help: "Markdown, highlighted as you type. It is sent to the model as the text it is — nothing here renders it.",
          on: (v) => this.patch({ body: v }) })}
      </div>
      ${this.formActions(
        () => this.act(() => createPrompt(p.promptName, p.body)), "Save version")}
    `;
  }

  // --- templates ----------------------------------------------------------------------
  //
  // Read-only here, deliberately. A template's value is its FILES — a real
  // .docx with its styles and tables already set — and a form that edited a
  // row while leaving the files untouchable would look like editing and not
  // be. Seeding is scenarios/office/seed_templates.py; this page is where an
  // operator sees what is offered, in what order, and retires one.

  private templatesTab() {
    return html`
      ${this.head("Templates", "file-text")}
      <div class="bar">
        <span class="dim">Starting points the capability pages offer. Files are
          seeded — scenarios/office/seed_templates.py — and shown here as they
          will appear.</span>
      </div>

      ${this.group("Templates", this.templates.length)}
      <table><tbody>
        ${this.templates.map((t) => html`<tr>
          <td class="name">${t.label}</td>
          <td><span class="tag">${t.kind}</span></td>
          <td class="fill dim"><span class="trunc">${t.description}</span></td>
          <td><span class="tag">${t.skillName === "" ? "no skill" : t.skillName}</span></td>
          <td><span class="tag">${(t.featuredRank ?? 0) === 0 ? "not featured" : `rank ${t.featuredRank}`}</span></td>
          ${this.rowActions([
            { icon: "trash", title: `Delete ${t.label}`, danger: true,
              run: () => this.act(() => deleteTemplate(t.id)) },
          ])}
        </tr>`)}
      </tbody></table>
      ${this.templates.length === 0
        ? html`<div class="none">No templates yet — run the seed script.</div>` : ""}
    `;
  }

  // --- skills -------------------------------------------------------------------------

  private skillsTab() {
    const v = this.view;
    if (v.kind === "skill") return this.skillForm(v.row, v.fresh, v.files);
    const usedBy = (id: string) =>
      this.agents.filter((a) => (a.skills ?? []).some((s) => s.id === id)).length;
    return html`
      ${this.head("Skills", "sticky-note")}
      <div class="bar">
        <button class="primary" data-new="skill"
          @click=${() => this.open({ kind: "skill", fresh: true, files: [],
            // private and unranked: a new skill is yours until you say
            // otherwise, and the featured row is a curated shelf rather than
            // wherever the newest skill happens to land.
            // local with no sourceUrl: a skill made here is one this
            // deployment owns and edits. The engine refuses the pair the other
            // way round — a 'repo' skill has to say which repository.
            row: { id: "", skillName: "", description: "", body: "", updatedAt: "",
                   visibility: "private", featuredRank: 0,
                   source: "local", sourceUrl: "" } })}>
          <nr-icon name="plus" size="small"></nr-icon> New skill
        </button>
      </div>

      ${this.group("Skills", this.skills.length)}
      <table><tbody>
        ${this.skills.map((k) => html`<tr>
          <td class="name">${k.skillName}</td>
          <td class="fill dim"><span class="trunc">${k.description}</span></td>
          <td><span class="tag">${usedBy(k.id)} agent${usedBy(k.id) === 1 ? "" : "s"}</span></td>
          ${this.rowActions([
            { icon: "edit", title: `Edit ${k.skillName}`,
              run: async () => this.open({ kind: "skill", row: { ...k }, fresh: false,
                files: await listSkillFiles(k.id) }) },
            { icon: "trash", title: `Delete ${k.skillName}`, danger: true,
              run: () => this.act(() => deleteSkill(k.id)) },
          ])}
        </tr>`)}
      </tbody></table>
      <p class="note">The briefing shows each agent its skills as one line each; the body arrives
      only when the model loads it with use_skill. Editing is in place — a skill is read fresh on
      every load, so the next call sees the change.</p>
    `;
  }

  private skillForm(k: SkillRow, fresh: boolean, files: SkillFileRow[]) {
    return html`
      ${this.formHead(fresh ? "New skill" : `Edit ${k.skillName}`)}
      <div class="grid">
        ${this.text({ id: "sk-name", label: "Name", value: k.skillName, required: true,
          disabled: !fresh, placeholder: "read-proto-enums",
          help: fresh
            ? "What the model sends to use_skill — and a directory name in the container, so letters, digits, dot, dash, underscore."
            : "The name is what agents' briefings already say, so it is fixed once the row exists.",
          on: (v) => this.patch({ skillName: v }) })}
        ${this.text({ id: "sk-id", label: "Id", value: k.id, required: true,
          disabled: !fresh, placeholder: "k-read-proto-enums",
          on: (v) => this.patch({ id: v }) })}
        ${this.text({ id: "sk-desc", label: "Description", value: k.description, wide: true, required: true,
          placeholder: "One line: when should a model reach for this?",
          help: "The line the briefing shows on every turn — it is how the skill is chosen, so write it for the moment of need.",
          on: (v) => this.patch({ description: v }) })}
        ${this.editor({ id: "sk-body", label: "Instructions", value: k.body, required: true,
          help: "Markdown. Loaded whole by use_skill when a task matches the description — procedures, invocations, the files below and how to run them.",
          on: (v) => this.patch({ body: v }) })}
      </div>
      ${this.formActions(() => this.act(() =>
        fresh ? createSkill({ ...k, updatedAt: new Date().toISOString() })
              : updateSkill({ ...k, updatedAt: new Date().toISOString() })))}

      ${fresh ? "" : html`
        ${this.group("Files", files.length)}
        <p class="note">Staged into the conversation's container at
        <span class="slug">/skills/${k.skillName}/</span> fresh on every run — the body should tell
        the model to run them rather than retype them.</p>
        ${files.map((f) => html`
          <div class="grid">
            ${this.editor({ id: `sk-file-${f.path}`, label: f.path, value: f.body,
              on: (v) => this.patchFile(f.id, v) })}
          </div>
          <div class="bar">
            <button class="act" title=${`Save ${f.path}`}
              @click=${() => this.fileAct(k, () => updateSkillFile(files.find((x) => x.id === f.id) ?? f))}>
              <nr-icon name="check" size="small"></nr-icon> Save ${f.path}</button>
            <button class="act danger" title=${`Delete ${f.path}`}
              @click=${() => this.fileAct(k, () => deleteSkillFile(k.id, f.id))}>
              <nr-icon name="trash" size="small"></nr-icon></button>
          </div>
        `)}
        <div class="grid">
          ${this.text({ id: "sk-newfile", label: "New file", value: "",
            placeholder: "enums.py",
            help: "A plain name; it appears under this skill's directory. Add it, then edit its body above.",
            on: () => undefined })}
        </div>
        <div class="bar">
          <button class="act" data-new="skill-file" @click=${() => this.addFile(k)}>
            <nr-icon name="plus" size="small"></nr-icon> Add file</button>
        </div>
      `}
    `;
  }

  // A file edit stays on the form: the view's copy is patched as the editor
  // types, and a save re-reads the file list rather than trusting the draft.
  private patchFile(fileId: string, body: string) {
    const v = this.view;
    if (v.kind !== "skill") return;
    this.view = { ...v, files: v.files.map((f) => f.id === fileId ? { ...f, body } : f) };
  }

  private async fileAct(k: SkillRow, work: () => Promise<unknown>) {
    this.problem = "";
    try {
      await work();
      const files = await listSkillFiles(k.id);
      this.view = { kind: "skill", row: k, fresh: false, files };
    } catch (e) { this.problem = e instanceof Error ? e.message : String(e); }
  }

  private async addFile(k: SkillRow) {
    const name = (this.renderRoot.querySelector("#sk-newfile") as unknown as { value?: string })?.value ?? "";
    if (name.trim() === "") { this.problem = "a file needs a name"; return; }
    await this.fileAct(k, () => createSkillFile({
      id: `${k.id}:${name.trim()}`, skillId: k.id, path: name.trim(),
      body: "# " + name.trim() + "\n",
    }));
  }

  // --- MCP servers --------------------------------------------------------------------

  /* The gallery announces, this performs — the same split the model picker
     uses. Keeping the POST here means adding from a card and adding by hand
     converge on one code path, so a server row has one writer however it was
     created. `act` already refreshes the lists and surfaces a refusal. */
  private addFromGallery(ask: {
    serverName: string; transport: string; endpoint: string;
    authKind: string; authHeader: string; enabled: boolean;
  }) {
    // A name collision is the one thing the shelf can cause that the form
    // cannot: two people adding "github" from the same card. Suffixed rather
    // than refused, because the person's intent is unambiguous.
    const taken = new Set(this.servers.map((s) => s.serverName));
    let name = ask.serverName;
    let n = 2;
    while (taken.has(name)) { name = ask.serverName + "-" + String(n); n = n + 1; }
    // And an id, which the shelf has to invent because the form asks a person
    // to type one. Without this, every Add on this page answered `an "id" is
    // required` in red at the bottom of the shelf and added nothing — the row
    // spread from NEW_SERVER, whose id is "" precisely because the form fills
    // it in. Derived from the name rather than a UUID: an id is in the URL of
    // every route about this server and in the key its token is stored under,
    // and "github-2" reads better than a hex block in both places.
    const ids = new Set(this.servers.map((s) => s.id));
    let id = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (id === "") { id = "connector"; }
    const stem = id;
    let k = 2;
    while (ids.has(id)) { id = stem + "-" + String(k); k = k + 1; }
    // Field by field, and never a spread of NEW_SERVER — that draft carries a
    // `token`, which is the console's own field for the form's password box
    // and is NOT on the engine's row. JSON.parse<McpServerRow> refuses a
    // document with a member it does not declare, so every Add on this shelf
    // answered "invalid JSON (UnknownField)". The save path in serverForm
    // builds its row the same explicit way, for the same reason.
    void this.act(() => createServer({
      id, serverName: name, transport: ask.transport, endpoint: ask.endpoint,
      authKind: ask.authKind, authHeader: ask.authHeader, enabled: ask.enabled,
    }));
  }

  /* Services you can reach, as opposed to bundles you install.
     The shelf lives here rather than in MCP for the reason the tab list gives.
     A connector added from a card still becomes an ordinary MCP server row —
     one writer for that table, whichever door you came through — which is why
     the count below reads off `servers` and why an entry already configured
     shows as Added rather than being hidden. */
  private connectorsTab() {
    return html`
      ${this.head("Connectors", "plug")}
      <div class="banner">A connector is a service this deployment can call, over
        MCP. Adding one from the shelf writes a server row you can then edit under
        <strong>MCP</strong> — the shelf fills the form in, it does not own the
        result. Entries arrive switched off: adding something from a shelf is
        interest, not trust, and one that needs a token would otherwise fail every
        call until somebody noticed.</div>

      ${this.group("Ready-made")}
      <mcp-gallery
        .taken=${this.servers.map((s) => s.endpoint)}
        @add-server=${(e: CustomEvent) => this.addFromGallery(e.detail)}></mcp-gallery>

      ${this.group("Yours", this.servers.length)}
      ${this.servers.length === 0
        ? html`<p class="empty">None yet.</p>`
        : html`<table><tbody>
            ${this.servers.map((s) => html`<tr>
              <td class="name">${s.serverName}</td>
              <td class="fill"><span class="slug">${s.endpoint}</span></td>
              <td><span class="tag">${s.authKind === "none" ? "no auth" : s.authKind}</span></td>
              <td>${s.enabled ? "" : html`<span class="tag off">off</span>`}</td>
              ${this.rowActions([
                { icon: "edit", title: `Edit ${s.serverName}`,
                  run: () => this.open({ kind: "server", row: { ...s, token: "" }, fresh: false }) },
              ])}
            </tr>`)}
          </tbody></table>`}

      ${this.group("Your access")}
      <p class="note">A connector that authenticates can carry a token that is
      <em>yours</em>: your conversations call out as you, everybody else keeps
      using the deployment's token, and neither can ever be read back out.</p>
      ${this.servers.filter((s) => s.authKind !== "" && s.authKind !== "none").length === 0
        ? html`<p class="empty">No connector here needs a token.</p>`
        : html`<table><tbody>
            ${this.servers.filter((s) => s.authKind !== "" && s.authKind !== "none").map((s) => html`<tr>
              <td class="name">${s.serverName}</td>
              <td>${this.mine.get(s.id) === true
                ? html`<span class="tag">your token</span>`
                : html`<span class="tag off">deployment's</span>`}</td>
              <td class="fill"><nr-input id=${"mine-" + s.id} type="password"
                placeholder=${this.mine.get(s.id) === true ? "unchanged" : "paste a token"}></nr-input></td>
              ${this.rowActions([
                { icon: "check", title: `Save your ${s.serverName} token`,
                  run: () => this.saveMine(s.id) },
                { icon: "trash", title: `Forget your ${s.serverName} token`, danger: true,
                  run: () => this.act(async () => {
                    await forgetServerMine(s.id);
                    await this.loadMine();
      this.authProviders = await listAuthProviders().catch(() => []);
                  }) },
              ])}
            </tr>`)}
          </tbody></table>`}

      ${this.group("Authorised apps")}
      <p class="empty">Nothing yet. This is where an app you signed in to with
        OAuth will appear — authorised rather than configured, with no endpoint
        or token to paste. Until one lands, everything above is a server you add
        by address.</p>`;
  }

  /* Bundles, installed from a manifest somebody else publishes.
     What makes this a tab of its own rather than a section of Connectors: a
     plugin is not a thing you configure, it is a thing you acquire, and what
     it leaves behind is ordinary skills and ordinary connectors that the other
     two tabs already own. So there is no edit form here — only install, what
     it brought, and remove. */
  private pluginsTab() {
    return html`
      ${this.head("Plugins", "cube")}
      <div class="banner">A plugin is a bundle: one manifest that installs a set of
        skills and connectors together, from a URL rather than a form. What it
        installs shows up under <strong>Skills</strong> and
        <strong>Connectors</strong> as ordinary rows — its skills are read-only
        here, because they are edited where they are published, and removing the
        plugin takes back exactly what it brought.</div>

      <div class="grid">
        ${this.text({ id: "pl-url", label: "Manifest URL", value: this.pluginUrl, wide: true,
          placeholder: "https://raw.githubusercontent.com/owner/repo/main/joule-plugin.json",
          help: "A GitHub page URL works too — it is rewritten to the raw one.",
          on: (v) => { this.pluginUrl = v; } })}
      </div>
      <div class="bar">
        <button class="act" data-new="plugin-inspect" ?disabled=${this.pluginBusy}
          @click=${() => void this.inspect()}>
          <nr-icon name="search" size="small"></nr-icon>
          ${this.pluginBusy ? "Reading…" : "Read the manifest"}</button>
        ${this.preview === null || this.preview.problem !== "" ? "" : html`
          <button class="primary" data-new="plugin-install" ?disabled=${this.pluginBusy}
            @click=${() => void this.installPreviewed()}>
            <nr-icon name="download" size="small"></nr-icon> Install ${this.preview.name}</button>`}
      </div>

      <!-- Read before installed, always. A manifest is somebody else's path
           into this deployment's skill table, and an Install button with no
           preview does an unknown number of unknown things. It is also where a
           name collision surfaces while it is still free to fix. -->
      ${this.preview === null ? "" : html`
        ${this.group("This manifest installs")}
        ${this.preview.problem === "" ? "" : html`
          <p class="why">${this.preview.problem}</p>`}
        <table><tbody>
          ${this.preview.skills.map((s) => html`<tr>
            <td><span class="tag">skill</span></td>
            <td class="name">${s.name}</td>
            <td class="fill">${s.description}</td>
            <td>${s.files === 0 ? "" : html`<span class="tag">${s.files} file${s.files === 1 ? "" : "s"}</span>`}</td>
          </tr>`)}
          ${this.preview.connectors.map((c) => html`<tr>
            <td><span class="tag">connector</span></td>
            <td class="name">${c.name}</td>
            <td class="fill"><span class="slug">${c.endpoint}</span></td>
            <td><span class="tag">${c.authKind === "none" ? "no auth" : c.authKind}</span></td>
          </tr>`)}
        </tbody></table>
        <p class="note">Skills arrive private and connectors arrive switched off —
        the same rule the connector shelf keeps. Turn on what you meant to use.</p>`}

      ${this.group("Installed", this.plugins.length)}
      ${this.plugins.length === 0
        ? html`<p class="empty">None yet. A plugin is the only one of the three
            that you do not write or address — you install it, and this is where
            the ones you installed are listed.</p>`
        : html`<table><tbody>
            ${this.plugins.map((p) => html`<tr>
              <td class="name">${p.pluginName}</td>
              <td class="fill">${p.description}</td>
              <td>${p.version === "" ? "" : html`<span class="tag">v${p.version}</span>`}</td>
              <td><span class="slug">${(this.pluginBrought.get(p.id) ?? []).length} item${(this.pluginBrought.get(p.id) ?? []).length === 1 ? "" : "s"}</span></td>
              ${this.rowActions([
                { icon: "trash", title: `Remove ${p.pluginName} and what it installed`, danger: true,
                  run: () => this.act(async () => {
                    await removePlugin(p.id);
                    await this.loadPlugins();
                  }) },
              ])}
            </tr>`)}
          </tbody></table>
          <p class="note">Removing a plugin deletes the skills and connectors it
          installed — a copy you took of one of its skills is your own row and
          stays.</p>`}`;
  }

  // Read a manifest without installing it.
  private async inspect() {
    this.problem = "";
    this.preview = null;
    const url = this.pluginUrl.trim();
    if (url === "") { this.problem = "a plugin is installed from a manifest URL"; return; }
    this.pluginBusy = true;
    try {
      this.preview = await inspectPlugin(url);
    } catch (e) { this.problem = e instanceof Error ? e.message : String(e); }
    finally { this.pluginBusy = false; }
  }

  private async installPreviewed() {
    this.pluginBusy = true;
    try {
      await installPlugin(this.pluginUrl.trim());
      this.preview = null;
      this.pluginUrl = "";
      // Both lists, because an install writes into both tables — leaving the
      // Skills tab showing the old set until a reload is how you get somebody
      // reporting that a plugin installed nothing.
      await this.loadPlugins();
      await this.refresh();
    } catch (e) { this.problem = e instanceof Error ? e.message : String(e); }
    finally { this.pluginBusy = false; }
  }

  private async loadMine() {
    const held = new Map<string, boolean>();
    for (const s of this.servers) {
      if (s.authKind === "" || s.authKind === "none") continue;
      try { held.set(s.id, (await serverMine(s.id)).stored); } catch { held.set(s.id, false); }
    }
    this.mine = held;
  }

  private async saveMine(id: string) {
    const box = this.renderRoot.querySelector(`#mine-${CSS.escape(id)}`) as unknown as { value?: string } | null;
    const token = (box?.value ?? "").trim();
    if (token === "") { this.problem = "paste a token first — an empty save would mean forget, and Forget is its own button"; return; }
    await this.act(async () => {
      await setServerMine(id, token);
      await this.loadMine();
      this.authProviders = await listAuthProviders().catch(() => []);
    });
  }

  private async loadPlugins() {
    this.plugins = await listPlugins();
    const brought = new Map<string, PluginItem[]>();
    // Sequential rather than Promise.all: this is a settings tab with a
    // handful of rows, and a burst of parallel calls to the same engine buys
    // nothing a person could perceive.
    for (const p of this.plugins) {
      try { brought.set(p.id, await pluginItems(p.id)); } catch { brought.set(p.id, []); }
    }
    this.pluginBrought = brought;
  }

  private mcpTab() {
    const v = this.view;
    if (v.kind === "server") return this.serverForm(v.row, v.fresh);
    return html`
      ${this.head("MCP", "code")}
      <div class="bar">
        <button class="primary" data-new="server"
          @click=${() => this.open({ kind: "server", row: { ...NEW_SERVER }, fresh: true })}>
          <nr-icon name="plus" size="small"></nr-icon> New server
        </button>
      </div>

      ${this.group("Servers", this.servers.length)}
      <table><tbody>
        ${this.servers.map((s) => html`<tr>
          <td class="name">${s.serverName}</td>
          <td class="fill"><span class="slug">${s.endpoint}</span></td>
          <td><span class="tag">${s.transport}</span></td>
          <td><span class="tag">${s.authKind === "none" ? "no auth" : s.authKind}</span></td>
          <td>${s.enabled ? "" : html`<span class="tag off">off</span>`}</td>
          ${this.rowActions([
            { icon: "edit", title: `Edit ${s.serverName}`,
              run: () => this.open({ kind: "server", row: { ...s, token: "" }, fresh: false }) },
            { icon: "trash", title: `Delete ${s.serverName}`, danger: true,
              run: () => this.act(() => deleteServer(s.id)) },
          ])}
        </tr>`)}
      </tbody></table>
      <p class="note">A server's tools are asked of the server itself, so a tool appears here
      the moment the server offers it.</p>
    `;
  }

  private serverForm(s: ServerRow & { token: string }, fresh: boolean) {
    return html`
      ${this.formHead(fresh ? "New server" : `Edit ${s.serverName}`)}
      <div class="grid">
        ${this.text({ id: "s-name", label: "Name", value: s.serverName, required: true,
          placeholder: "What this server is called", on: (v) => this.patch({ serverName: v }) })}
        ${this.text({ id: "s-id", label: "Id", value: s.id, required: true, disabled: !fresh,
          placeholder: "docflow", on: (v) => this.patch({ id: v }) })}
        ${this.text({ id: "s-endpoint", label: "Endpoint", value: s.endpoint, required: true,
          wide: true, placeholder: "http://…/mcp", on: (v) => this.patch({ endpoint: v }) })}
        <!-- http is the only transport the API accepts: stdio is a subprocess
             and this server has none to spawn. -->
        ${this.choice({ id: "s-transport", label: "Transport", value: s.transport,
          options: withCurrent(["http"], s.transport),
          on: (v) => this.patch({ transport: v }) })}
        ${this.choice({ id: "s-authkind", label: "Authentication", value: s.authKind,
          options: [
            { value: "none", label: "none" },
            { value: "bearer", label: "bearer" },
            { value: "header", label: "custom header" },
          ],
          on: (v) => this.patch({ authKind: v }) })}
        ${s.authKind === "header" ? this.text({ id: "s-authheader", label: "Header name",
          value: s.authHeader, required: true, placeholder: "X-Api-Key",
          on: (v) => this.patch({ authHeader: v }) }) : ""}
        ${s.authKind === "none" ? "" : this.text({ id: "s-token", label: "Token",
          type: "password", value: s.token, placeholder: fresh ? "" : "unchanged",
          help: "Stored encrypted under the server's id and never read back. Leaving it blank keeps the token already stored.",
          on: (v) => this.patch({ token: v }) })}
        ${this.check({ id: "s-enabled", label: "Enabled", checked: s.enabled,
          on: (v) => this.patch({ enabled: v }) })}
      </div>
      ${this.formActions(() => this.act(async () => {
        const row: ServerRow = {
          id: s.id, serverName: s.serverName, transport: s.transport,
          endpoint: s.endpoint, authKind: s.authKind, authHeader: s.authHeader,
          enabled: s.enabled,
        };
        if (fresh) { await createServer(row); } else { await updateServer(row); }
        // Only when one was typed: an empty token here would replace a working
        // credential with an unreadable envelope, and it can never be read back
        // to notice.
        if (s.token !== "") { await setServerAuth(s.id, s.authKind, s.authHeader, s.token); }
      }))}
    `;
  }

  // --- provider credentials -----------------------------------------------------------

  private providersTab() {
    const v = this.view;
    if (v.kind === "key") return this.keyForm(v.row);
    return html`
      ${this.head("Providers", "cloud")}
      <div class="bar">
        <button class="primary" data-new="key"
          @click=${() => this.open({ kind: "key", row: { provider: PROVIDERS[0], apiKey: "" } })}>
          <nr-icon name="plus" size="small"></nr-icon> New credential
        </button>
      </div>

      ${this.group("Credentials", this.providers.length)}
      ${this.providers.length === 0
        ? html`<p class="empty">No credential is stored, so no model can be reached.</p>`
        : html`<table><tbody>
            ${this.providers.map((p) => html`<tr>
              <td class="name">${p}</td>
              <td class="fill"><span class="tag live">stored</span></td>
              ${this.rowActions([
                { icon: "key", title: `Replace the ${p} key`,
                  run: () => this.open({ kind: "key", row: { provider: p, apiKey: "" } }) },
              ])}
            </tr>`)}
          </tbody></table>`}
      <p class="note">Keys are encrypted under LUMEN_MASTER_KEY. The API answers which
      providers have one, never the key itself.</p>
    `;
  }

  private keyForm(k: { provider: string; apiKey: string }) {
    const held = this.providers.includes(k.provider);
    return html`
      ${this.formHead(held ? `Replace the ${k.provider} key` : "New credential")}
      <div class="grid">
        ${this.choice({ id: "k-provider", label: "Provider", value: k.provider, required: true,
          options: withCurrent(PROVIDERS, k.provider), on: (v) => this.patch({ provider: v }) })}
        ${this.text({ id: "k-key", label: "API key", value: k.apiKey, type: "password",
          required: true, placeholder: "sk-…",
          help: "Written once and never read back — replacing it is the only way to change it.",
          on: (v) => this.patch({ apiKey: v }) })}
      </div>
      ${this.formActions(() => this.act(() => storeProviderKey(k.provider, k.apiKey)), "Store")}
    `;
  }

  // --- tracing ------------------------------------------------------------------------

  // A panel rather than a list: there is one row and it is always the same one.
  /* Signing in with something that is not a password.
   *
   * The same auth module answers both: LumenJS takes a native provider and
   * any number of OIDC ones, and discovers every endpoint from the issuer. So
   * a provider is a row plus a secret rather than a deploy — which is the
   * whole reason this screen exists.
   *
   * Two shelves, like Connectors: ready-made issuers for the ones people
   * actually ask for, and the list of what this deployment offers. Adding
   * from a card fills the form in; it does not own the result. */
  private signInTab() {
    const ready = [
      { id: "google", label: "Google", kind: "oidc", issuer: "https://accounts.google.com",
        note: "Console: APIs & Services → Credentials → OAuth client ID (Web application)" },
      { id: "linkedin", label: "LinkedIn", kind: "oidc", issuer: "https://www.linkedin.com/oauth",
        note: "LinkedIn Developers → your app → Auth → Sign In with LinkedIn using OpenID Connect" },
      { id: "github", label: "GitHub", kind: "github", issuer: "",
        note: "GitHub → Settings → Developer settings → OAuth Apps → New OAuth App" },
    ];
    const have = new Set(this.authProviders.map((p) => p.id));
    return html`
      ${this.head("Sign-in", "log-in")}
      <div class="banner">How people get into this console. The password form is
        always there; each provider added here becomes a button beside it. A
        provider is an <strong>issuer</strong> and a <strong>client</strong> —
        the endpoints are discovered from the issuer, so anything publishing an
        OpenID configuration works, not only the two below. The client secret is
        stored encrypted and never read back.</div>

      ${this.group("Ready-made")}
      <div class="cards">
        ${ready.map((r) => html`
          <div class="card">
            <div class="top"><span class="name">${r.label}</span></div>
            <div class="what"><span class="slug">${r.issuer}</span></div>
            <div class="needs">${r.note}</div>
            <div class="foot">
              ${have.has(r.id)
                ? html`<span class="have">Added</span>`
                : html`<button class="act" @click=${() => this.open({ kind: "authp", fresh: true,
                    row: { id: r.id, label: r.label, kind: r.kind, issuer: r.issuer, clientId: "",
                           scopes: "", enabled: false } })}>Add</button>`}
            </div>
          </div>`)}
      </div>

      ${this.group("Yours", this.authProviders.length)}
      ${this.authProviders.length === 0
        ? html`<p class="empty">None yet — people sign in with a password.</p>`
        : html`<table><tbody>
            ${this.authProviders.map((p) => html`<tr>
              <td class="name">${p.label}</td>
              <td class="fill"><span class="slug">${p.kind === "github" ? "github.com (OAuth2)" : p.issuer}</span></td>
              <td>${p.configured === true
                ? html`<span class="tag">secret stored</span>`
                : html`<span class="tag off">no secret</span>`}</td>
              <td>${p.enabled ? "" : html`<span class="tag off">off</span>`}</td>
              ${this.rowActions([
                { icon: "edit", title: `Edit ${p.label}`,
                  run: () => this.open({ kind: "authp", row: { ...p }, fresh: false }) },
                { icon: "trash", title: `Remove ${p.label}`, danger: true,
                  run: () => this.act(async () => {
                    await deleteAuthProvider(p.id);
                    this.authProviders = await listAuthProviders();
                  }) },
              ])}
            </tr>`)}
          </tbody></table>
          <p class="note">A provider with no secret is never offered: its button
          would be a dead end. The callback this deployment registers is
          <span class="slug">${location.origin}/__nk_auth/callback</span> — paste
          that into the provider's console.</p>`}`;
  }

  private authProviderForm(row: AuthProviderRow, fresh: boolean) {
    return html`
      ${this.formHead(fresh ? "New sign-in provider" : `Edit ${row.label}`)}
      <div class="grid">
        ${this.text({ id: "ap-id", label: "Id", value: row.id, required: true, disabled: !fresh,
          placeholder: "google",
          help: "Lowercase, no spaces — it appears in the callback URL.",
          on: (v) => this.patch({ id: v }) })}
        ${this.text({ id: "ap-label", label: "Button label", value: row.label, required: true,
          placeholder: "Google", on: (v) => this.patch({ label: v }) })}
        ${(row.kind || "oidc") === "github" ? "" : this.text({ id: "ap-issuer", label: "Issuer", value: row.issuer, required: true, wide: true,
          placeholder: "https://accounts.google.com",
          help: "Its /.well-known/openid-configuration is what describes every endpoint.",
          on: (v) => this.patch({ issuer: v }) })}
        ${this.text({ id: "ap-client", label: "Client id", value: row.clientId, required: true, wide: true,
          on: (v) => this.patch({ clientId: v }) })}
        ${this.text({ id: "ap-secret", label: "Client secret", type: "password", value: "",
          placeholder: row.configured === true ? "unchanged" : "",
          help: "Stored encrypted under the provider's id and never read back. Leave blank to keep the one already stored.",
          on: () => undefined })}
        ${this.text({ id: "ap-scopes", label: "Extra scopes", value: row.scopes, wide: true,
          placeholder: "openid profile email are always requested",
          on: (v) => this.patch({ scopes: v }) })}
        ${this.check({ id: "ap-enabled", label: "Offer this provider", checked: row.enabled,
          on: (v) => this.patch({ enabled: v }) })}
      </div>
      ${this.formActions(() => this.act(async () => {
        await saveAuthProvider(row, fresh);
        // Only when one was typed: an empty save would replace a working
        // secret with an unreadable envelope, and it can never be read back
        // to notice — the same rule the server form keeps.
        const box = this.renderRoot.querySelector("#ap-secret") as unknown as { value?: string } | null;
        const secret = (box?.value ?? "").trim();
        if (secret !== "") { await setAuthProviderSecret(row.id, secret); }
        this.authProviders = await listAuthProviders();
      }))}
    `;
  }

  private tracingTab() {
    const t = this.tracing;
    const state = t === null ? "…"
      : t.configured ? (t.active ? "Active" : "Configured, disabled")
      : "Not configured";
    const edit = (fields: Partial<typeof this.trace>) => { this.trace = { ...this.trace, ...fields }; };
    return html`
      ${this.head("Tracing", "layers")}
      <div class="formhead"><h3>${state}</h3></div>

      <div class="grid">
        ${this.choice({ id: "t-backend", label: "Backend", value: this.trace.backend,
          options: withCurrent(BACKENDS, this.trace.backend), required: true,
          help: "Checked when it is set rather than at the first trace — a typo that silently turns tracing off later is found by nobody.",
          on: (v) => edit({ backend: v }) })}
        ${this.text({ id: "t-endpoint", label: "Endpoint", value: this.trace.endpoint,
          placeholder: "https://…/v1/traces", on: (v) => edit({ endpoint: v }) })}
        ${this.text({ id: "t-public", label: "Public key", value: this.trace.publicKey,
          placeholder: "public key, project or space",
          on: (v) => edit({ publicKey: v }) })}
        ${this.text({ id: "t-service", label: "Service name", value: this.trace.serviceName,
          placeholder: "lumen-agents", on: (v) => edit({ serviceName: v }) })}
        ${this.text({ id: "t-env", label: "Environment", value: this.trace.environment,
          placeholder: "production",
          help: "These two were constants once, so opening this tab and pressing Save refiled a staging deployment's traces under production.",
          on: (v) => edit({ environment: v }) })}
        ${this.check({ id: "t-enabled", label: "Enabled", checked: this.trace.enabled,
          on: (v) => edit({ enabled: v }) })}
      </div>
      <div class="formacts">
        <button class="primary" @click=${() => this.act(() => configureTracing({
          id: "default", backend: this.trace.backend, endpoint: this.trace.endpoint,
          publicKey: this.trace.publicKey, serviceName: this.trace.serviceName,
          environment: this.trace.environment, enabled: this.trace.enabled,
        }), { kind: "list" })}>Save</button>
      </div>

      ${this.group("Secret")}
      <div class="grid">
        ${this.text({ id: "t-secret", label: "Secret key", value: this.trace.secret,
          type: "password", placeholder: "sk-lf-…",
          help: "Stored the same way a provider key is: encrypted, and never handed back.",
          on: (v) => edit({ secret: v }) })}
      </div>
      <div class="formacts">
        <button class="ghost" @click=${() => this.act(async () => {
          await setTracingSecret(this.trace.secret);
          this.trace = { ...this.trace, secret: "" };
        }, { kind: "list" })}>Store secret</button>
      </div>
    `;
  }
}
