/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
var _a2;
const ariaMixinAttributes = {
  ariaAtomic: "aria-atomic",
  ariaAutoComplete: "aria-autocomplete",
  ariaBrailleLabel: "aria-braillelabel",
  ariaBrailleRoleDescription: "aria-brailleroledescription",
  ariaBusy: "aria-busy",
  ariaChecked: "aria-checked",
  ariaColCount: "aria-colcount",
  ariaColIndex: "aria-colindex",
  ariaColIndexText: "aria-colindextext",
  ariaColSpan: "aria-colspan",
  ariaCurrent: "aria-current",
  ariaDescription: "aria-description",
  ariaDisabled: "aria-disabled",
  ariaExpanded: "aria-expanded",
  ariaHasPopup: "aria-haspopup",
  ariaHidden: "aria-hidden",
  ariaInvalid: "aria-invalid",
  ariaKeyShortcuts: "aria-keyshortcuts",
  ariaLabel: "aria-label",
  ariaLevel: "aria-level",
  ariaLive: "aria-live",
  ariaModal: "aria-modal",
  ariaMultiLine: "aria-multiline",
  ariaMultiSelectable: "aria-multiselectable",
  ariaOrientation: "aria-orientation",
  ariaPlaceholder: "aria-placeholder",
  ariaPosInSet: "aria-posinset",
  ariaPressed: "aria-pressed",
  ariaReadOnly: "aria-readonly",
  ariaRelevant: "aria-relevant",
  ariaRequired: "aria-required",
  ariaRoleDescription: "aria-roledescription",
  ariaRowCount: "aria-rowcount",
  ariaRowIndex: "aria-rowindex",
  ariaRowIndexText: "aria-rowindextext",
  ariaRowSpan: "aria-rowspan",
  ariaSelected: "aria-selected",
  ariaSetSize: "aria-setsize",
  ariaSort: "aria-sort",
  ariaValueMax: "aria-valuemax",
  ariaValueMin: "aria-valuemin",
  ariaValueNow: "aria-valuenow",
  ariaValueText: "aria-valuetext",
  role: "role"
};
const ElementInternalsShim = class ElementInternals {
  get shadowRoot() {
    return this.__host.__shadowRoot;
  }
  constructor(_host) {
    this.ariaActiveDescendantElement = null;
    this.ariaAtomic = "";
    this.ariaAutoComplete = "";
    this.ariaBrailleLabel = "";
    this.ariaBrailleRoleDescription = "";
    this.ariaBusy = "";
    this.ariaChecked = "";
    this.ariaColCount = "";
    this.ariaColIndex = "";
    this.ariaColIndexText = "";
    this.ariaColSpan = "";
    this.ariaControlsElements = null;
    this.ariaCurrent = "";
    this.ariaDescribedByElements = null;
    this.ariaDescription = "";
    this.ariaDetailsElements = null;
    this.ariaDisabled = "";
    this.ariaErrorMessageElements = null;
    this.ariaExpanded = "";
    this.ariaFlowToElements = null;
    this.ariaHasPopup = "";
    this.ariaHidden = "";
    this.ariaInvalid = "";
    this.ariaKeyShortcuts = "";
    this.ariaLabel = "";
    this.ariaLabelledByElements = null;
    this.ariaLevel = "";
    this.ariaLive = "";
    this.ariaModal = "";
    this.ariaMultiLine = "";
    this.ariaMultiSelectable = "";
    this.ariaOrientation = "";
    this.ariaOwnsElements = null;
    this.ariaPlaceholder = "";
    this.ariaPosInSet = "";
    this.ariaPressed = "";
    this.ariaReadOnly = "";
    this.ariaRelevant = "";
    this.ariaRequired = "";
    this.ariaRoleDescription = "";
    this.ariaRowCount = "";
    this.ariaRowIndex = "";
    this.ariaRowIndexText = "";
    this.ariaRowSpan = "";
    this.ariaSelected = "";
    this.ariaSetSize = "";
    this.ariaSort = "";
    this.ariaValueMax = "";
    this.ariaValueMin = "";
    this.ariaValueNow = "";
    this.ariaValueText = "";
    this.role = "";
    this.form = null;
    this.labels = [];
    this.states = /* @__PURE__ */ new Set();
    this.validationMessage = "";
    this.validity = {};
    this.willValidate = true;
    this.__host = _host;
  }
  checkValidity() {
    console.warn("`ElementInternals.checkValidity()` was called on the server.This method always returns true.");
    return true;
  }
  reportValidity() {
    return true;
  }
  setFormValue() {
  }
  setValidity() {
  }
};
const HYDRATE_INTERNALS_ATTR_PREFIX = "hydrate-internals-";
/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
var __classPrivateFieldSet = function(receiver, state, value, kind, f2) {
  if (kind === "m") throw new TypeError("Private method is not writable");
  if (kind === "a" && !f2) throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f2 : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f2.call(receiver, value) : f2 ? f2.value = value : state.set(receiver, value), value;
};
var __classPrivateFieldGet = function(receiver, state, kind, f2) {
  if (kind === "a" && !f2) throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f2 : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f2 : kind === "a" ? f2.call(receiver) : f2 ? f2.value : state.get(receiver);
};
var _Event_cancelable, _Event_bubbles, _Event_composed, _Event_defaultPrevented, _Event_timestamp, _Event_propagationStopped, _Event_type, _Event_target, _Event_isBeingDispatched, _a$1, _CustomEvent_detail, _b;
const NONE = 0;
const CAPTURING_PHASE = 1;
const AT_TARGET = 2;
const BUBBLING_PHASE = 3;
const enumerableProperty$1 = { __proto__: null };
enumerableProperty$1.enumerable = true;
Object.freeze(enumerableProperty$1);
const EventShim = (_a$1 = class Event {
  constructor(type, options = {}) {
    _Event_cancelable.set(this, false);
    _Event_bubbles.set(this, false);
    _Event_composed.set(this, false);
    _Event_defaultPrevented.set(this, false);
    _Event_timestamp.set(this, Date.now());
    _Event_propagationStopped.set(this, false);
    _Event_type.set(this, void 0);
    _Event_target.set(this, void 0);
    _Event_isBeingDispatched.set(this, void 0);
    this.NONE = NONE;
    this.CAPTURING_PHASE = CAPTURING_PHASE;
    this.AT_TARGET = AT_TARGET;
    this.BUBBLING_PHASE = BUBBLING_PHASE;
    if (arguments.length === 0)
      throw new Error(`The type argument must be specified`);
    if (typeof options !== "object" || !options) {
      throw new Error(`The "options" argument must be an object`);
    }
    const { bubbles, cancelable, composed } = options;
    __classPrivateFieldSet(this, _Event_cancelable, !!cancelable, "f");
    __classPrivateFieldSet(this, _Event_bubbles, !!bubbles, "f");
    __classPrivateFieldSet(this, _Event_composed, !!composed, "f");
    __classPrivateFieldSet(this, _Event_type, `${type}`, "f");
    __classPrivateFieldSet(this, _Event_target, null, "f");
    __classPrivateFieldSet(this, _Event_isBeingDispatched, false, "f");
  }
  initEvent(_type, _bubbles, _cancelable) {
    throw new Error("Method not implemented.");
  }
  stopImmediatePropagation() {
    this.stopPropagation();
  }
  preventDefault() {
    __classPrivateFieldSet(this, _Event_defaultPrevented, true, "f");
  }
  get target() {
    return __classPrivateFieldGet(this, _Event_target, "f");
  }
  get currentTarget() {
    return __classPrivateFieldGet(this, _Event_target, "f");
  }
  get srcElement() {
    return __classPrivateFieldGet(this, _Event_target, "f");
  }
  get type() {
    return __classPrivateFieldGet(this, _Event_type, "f");
  }
  get cancelable() {
    return __classPrivateFieldGet(this, _Event_cancelable, "f");
  }
  get defaultPrevented() {
    return __classPrivateFieldGet(this, _Event_cancelable, "f") && __classPrivateFieldGet(this, _Event_defaultPrevented, "f");
  }
  get timeStamp() {
    return __classPrivateFieldGet(this, _Event_timestamp, "f");
  }
  composedPath() {
    return __classPrivateFieldGet(this, _Event_isBeingDispatched, "f") ? [__classPrivateFieldGet(this, _Event_target, "f")] : [];
  }
  get returnValue() {
    return !__classPrivateFieldGet(this, _Event_cancelable, "f") || !__classPrivateFieldGet(this, _Event_defaultPrevented, "f");
  }
  get bubbles() {
    return __classPrivateFieldGet(this, _Event_bubbles, "f");
  }
  get composed() {
    return __classPrivateFieldGet(this, _Event_composed, "f");
  }
  get eventPhase() {
    return __classPrivateFieldGet(this, _Event_isBeingDispatched, "f") ? _a$1.AT_TARGET : _a$1.NONE;
  }
  get cancelBubble() {
    return __classPrivateFieldGet(this, _Event_propagationStopped, "f");
  }
  set cancelBubble(value) {
    if (value) {
      __classPrivateFieldSet(this, _Event_propagationStopped, true, "f");
    }
  }
  stopPropagation() {
    __classPrivateFieldSet(this, _Event_propagationStopped, true, "f");
  }
  get isTrusted() {
    return false;
  }
}, _Event_cancelable = /* @__PURE__ */ new WeakMap(), _Event_bubbles = /* @__PURE__ */ new WeakMap(), _Event_composed = /* @__PURE__ */ new WeakMap(), _Event_defaultPrevented = /* @__PURE__ */ new WeakMap(), _Event_timestamp = /* @__PURE__ */ new WeakMap(), _Event_propagationStopped = /* @__PURE__ */ new WeakMap(), _Event_type = /* @__PURE__ */ new WeakMap(), _Event_target = /* @__PURE__ */ new WeakMap(), _Event_isBeingDispatched = /* @__PURE__ */ new WeakMap(), _a$1.NONE = NONE, _a$1.CAPTURING_PHASE = CAPTURING_PHASE, _a$1.AT_TARGET = AT_TARGET, _a$1.BUBBLING_PHASE = BUBBLING_PHASE, _a$1);
Object.defineProperties(EventShim.prototype, {
  initEvent: enumerableProperty$1,
  stopImmediatePropagation: enumerableProperty$1,
  preventDefault: enumerableProperty$1,
  target: enumerableProperty$1,
  currentTarget: enumerableProperty$1,
  srcElement: enumerableProperty$1,
  type: enumerableProperty$1,
  cancelable: enumerableProperty$1,
  defaultPrevented: enumerableProperty$1,
  timeStamp: enumerableProperty$1,
  composedPath: enumerableProperty$1,
  returnValue: enumerableProperty$1,
  bubbles: enumerableProperty$1,
  composed: enumerableProperty$1,
  eventPhase: enumerableProperty$1,
  cancelBubble: enumerableProperty$1,
  stopPropagation: enumerableProperty$1,
  isTrusted: enumerableProperty$1
});
const CustomEventShim = (_b = class CustomEvent extends EventShim {
  constructor(type, options = {}) {
    super(type, options);
    _CustomEvent_detail.set(this, void 0);
    __classPrivateFieldSet(this, _CustomEvent_detail, (options == null ? void 0 : options.detail) ?? null, "f");
  }
  initCustomEvent(_type, _bubbles, _cancelable, _detail) {
    throw new Error("Method not implemented.");
  }
  get detail() {
    return __classPrivateFieldGet(this, _CustomEvent_detail, "f");
  }
}, _CustomEvent_detail = /* @__PURE__ */ new WeakMap(), _b);
Object.defineProperties(CustomEventShim.prototype, {
  detail: enumerableProperty$1
});
const EventShimWithRealType = EventShim;
const CustomEventShimWithRealType = CustomEventShim;
/**
 * @license
 * Copyright 2024 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
var _a;
_a = class CSSRule {
  constructor() {
    this.STYLE_RULE = 1;
    this.CHARSET_RULE = 2;
    this.IMPORT_RULE = 3;
    this.MEDIA_RULE = 4;
    this.FONT_FACE_RULE = 5;
    this.PAGE_RULE = 6;
    this.NAMESPACE_RULE = 10;
    this.KEYFRAMES_RULE = 7;
    this.KEYFRAME_RULE = 8;
    this.SUPPORTS_RULE = 12;
    this.COUNTER_STYLE_RULE = 11;
    this.FONT_FEATURE_VALUES_RULE = 14;
    this.MARGIN_RULE = 9;
    this.__parentStyleSheet = null;
    this.cssText = "";
  }
  get parentRule() {
    return null;
  }
  get parentStyleSheet() {
    return this.__parentStyleSheet;
  }
  get type() {
    return 0;
  }
}, _a.STYLE_RULE = 1, _a.CHARSET_RULE = 2, _a.IMPORT_RULE = 3, _a.MEDIA_RULE = 4, _a.FONT_FACE_RULE = 5, _a.PAGE_RULE = 6, _a.NAMESPACE_RULE = 10, _a.KEYFRAMES_RULE = 7, _a.KEYFRAME_RULE = 8, _a.SUPPORTS_RULE = 12, _a.COUNTER_STYLE_RULE = 11, _a.FONT_FEATURE_VALUES_RULE = 14, _a.MARGIN_RULE = 9, _a;
/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
globalThis.Event ?? (globalThis.Event = EventShimWithRealType);
globalThis.CustomEvent ?? (globalThis.CustomEvent = CustomEventShimWithRealType);
const constructionToken = Symbol();
const isCaptureEventListener = (options) => typeof options === "boolean" ? options : (options == null ? void 0 : options.capture) ?? false;
const enumerableProperty = { __proto__: null };
enumerableProperty.enumerable = true;
Object.freeze(enumerableProperty);
class EventTarget {
  constructor() {
    this.__eventListeners = /* @__PURE__ */ new Map();
    this.__captureEventListeners = /* @__PURE__ */ new Map();
  }
  addEventListener(type, callback, options) {
    var _a3;
    if (callback === void 0 || callback === null) {
      return;
    }
    const eventListenersMap = isCaptureEventListener(options) ? this.__captureEventListeners : this.__eventListeners;
    let eventListeners = eventListenersMap.get(type);
    if (eventListeners === void 0) {
      eventListeners = /* @__PURE__ */ new Map();
      eventListenersMap.set(type, eventListeners);
    } else if (eventListeners.has(callback)) {
      return;
    }
    const normalizedOptions = typeof options === "object" && options ? options : {};
    (_a3 = normalizedOptions.signal) == null ? void 0 : _a3.addEventListener("abort", () => this.removeEventListener(type, callback, options));
    eventListeners.set(callback, normalizedOptions ?? {});
  }
  removeEventListener(type, callback, options) {
    if (callback === void 0 || callback === null) {
      return;
    }
    const eventListenersMap = isCaptureEventListener(options) ? this.__captureEventListeners : this.__eventListeners;
    const eventListeners = eventListenersMap.get(type);
    if (eventListeners !== void 0) {
      eventListeners.delete(callback);
      if (!eventListeners.size) {
        eventListenersMap.delete(type);
      }
    }
  }
  dispatchEvent(event) {
    let composedPath = this.__resolveFullEventPath();
    if (!event.composed && this.__host) {
      composedPath = composedPath.slice(0, composedPath.indexOf(this.__host));
    }
    let stopPropagation = false;
    let stopImmediatePropagation = false;
    let eventPhase = EventShimWithRealType.NONE;
    let target = null;
    let tmpTarget = null;
    let currentTarget = null;
    const originalStopPropagation = event.stopPropagation;
    const originalStopImmediatePropagation = event.stopImmediatePropagation;
    Object.defineProperties(event, {
      target: {
        get() {
          return target ?? tmpTarget;
        },
        ...enumerableProperty
      },
      srcElement: {
        get() {
          return event.target;
        },
        ...enumerableProperty
      },
      currentTarget: {
        get() {
          return currentTarget;
        },
        ...enumerableProperty
      },
      eventPhase: {
        get() {
          return eventPhase;
        },
        ...enumerableProperty
      },
      composedPath: {
        value: () => composedPath,
        ...enumerableProperty
      },
      stopPropagation: {
        value: () => {
          stopPropagation = true;
          originalStopPropagation.call(event);
        },
        ...enumerableProperty
      },
      stopImmediatePropagation: {
        value: () => {
          stopImmediatePropagation = true;
          originalStopImmediatePropagation.call(event);
        },
        ...enumerableProperty
      }
    });
    const invokeEventListener = (listener, options, eventListenerMap) => {
      if (typeof listener === "function") {
        listener(event);
      } else if (typeof (listener == null ? void 0 : listener.handleEvent) === "function") {
        listener.handleEvent(event);
      }
      if (options.once) {
        eventListenerMap.delete(listener);
      }
    };
    const finishDispatch = () => {
      currentTarget = null;
      eventPhase = EventShimWithRealType.NONE;
      return !event.defaultPrevented;
    };
    const captureEventPath = composedPath.slice().reverse();
    target = !this.__host || !event.composed ? this : null;
    const retarget = (eventTargets) => {
      tmpTarget = this;
      while (tmpTarget.__host && eventTargets.includes(tmpTarget.__host)) {
        tmpTarget = tmpTarget.__host;
      }
    };
    for (const eventTarget of captureEventPath) {
      if (!target && (!tmpTarget || tmpTarget === eventTarget.__host)) {
        retarget(captureEventPath.slice(captureEventPath.indexOf(eventTarget)));
      }
      currentTarget = eventTarget;
      eventPhase = eventTarget === event.target ? EventShimWithRealType.AT_TARGET : EventShimWithRealType.CAPTURING_PHASE;
      const captureEventListeners = eventTarget.__captureEventListeners.get(event.type);
      if (captureEventListeners) {
        for (const [listener, options] of captureEventListeners) {
          invokeEventListener(listener, options, captureEventListeners);
          if (stopImmediatePropagation) {
            return finishDispatch();
          }
        }
      }
      if (stopPropagation) {
        return finishDispatch();
      }
    }
    const bubbleEventPath = event.bubbles ? composedPath : [this];
    tmpTarget = null;
    for (const eventTarget of bubbleEventPath) {
      if (!target && (!tmpTarget || eventTarget === tmpTarget.__host)) {
        retarget(bubbleEventPath.slice(0, bubbleEventPath.indexOf(eventTarget) + 1));
      }
      currentTarget = eventTarget;
      eventPhase = eventTarget === event.target ? EventShimWithRealType.AT_TARGET : EventShimWithRealType.BUBBLING_PHASE;
      const eventListeners = eventTarget.__eventListeners.get(event.type);
      if (eventListeners) {
        for (const [listener, options] of eventListeners) {
          invokeEventListener(listener, options, eventListeners);
          if (stopImmediatePropagation) {
            return finishDispatch();
          }
        }
      }
      if (stopPropagation) {
        return finishDispatch();
      }
    }
    return finishDispatch();
  }
  __resolveFullEventPath() {
    if (this.__eventPathCache) {
      return this.__eventPathCache;
    } else if (!this.__eventTargetParent) {
      return this.__eventPathCache = [this, documentShim, windowShim];
    } else {
      return this.__eventPathCache = [
        this,
        ...this.__eventTargetParent.__resolveFullEventPath()
      ];
    }
  }
}
const EventTargetShimWithRealType = EventTarget;
const attributes = /* @__PURE__ */ new WeakMap();
const attributesForElement = (element) => {
  let attrs = attributes.get(element);
  if (attrs === void 0) {
    attributes.set(element, attrs = /* @__PURE__ */ new Map());
  }
  return attrs;
};
const NodeShim = class Node extends EventTarget {
  getRootNode(options) {
    if (options == null ? void 0 : options.composed) {
      return document$1;
    }
    const host = this.__host;
    return (host == null ? void 0 : host.__shadowRoot) ?? document$1;
  }
};
const DocumentShim = class Document2 extends NodeShim {
  get adoptedStyleSheets() {
    return [];
  }
  createTreeWalker() {
    return {};
  }
  createTextNode() {
    return {};
  }
  createElement() {
    return {};
  }
};
const documentShim = new DocumentShim();
const document$1 = documentShim;
const WindowShim = class Window extends NodeShim {
  constructor(token) {
    super();
    if (token !== constructionToken) {
      throw new TypeError("Illegal constructor");
    }
    Object.assign(this, globalThis, {
      CustomElementRegistry,
      customElements,
      document: document$1,
      Document: DocumentShim,
      Element: ElementShim,
      EventTarget,
      HTMLElement: HTMLElementShim,
      Node: NodeShim,
      ShadowRoot: ShadowRootShim,
      window: this,
      Window: WindowShim
    });
  }
};
const ElementShim = class Element extends NodeShim {
  constructor() {
    super(...arguments);
    this.__shadowRootMode = null;
    this.__shadowRoot = null;
    this.__internals = null;
  }
  get attributes() {
    return Array.from(attributesForElement(this)).map(([name, value]) => ({
      name,
      value
    }));
  }
  get shadowRoot() {
    if (this.__shadowRootMode === "closed") {
      return null;
    }
    return this.__shadowRoot;
  }
  get localName() {
    return this.constructor.__localName;
  }
  get tagName() {
    var _a3;
    return (_a3 = this.localName) == null ? void 0 : _a3.toUpperCase();
  }
  setAttribute(name, value) {
    attributesForElement(this).set(name, String(value));
  }
  removeAttribute(name) {
    attributesForElement(this).delete(name);
  }
  toggleAttribute(name, force) {
    if (this.hasAttribute(name)) {
      if (force === void 0 || !force) {
        this.removeAttribute(name);
        return false;
      }
    } else {
      if (force === void 0 || force) {
        this.setAttribute(name, "");
        return true;
      } else {
        return false;
      }
    }
    return true;
  }
  hasAttribute(name) {
    return attributesForElement(this).has(name);
  }
  attachShadow(init) {
    this.__shadowRootMode = init.mode;
    const shadowRoot = new ShadowRootShim(constructionToken, init);
    shadowRoot.__eventTargetParent = this;
    shadowRoot.__host = this;
    return this.__shadowRoot = shadowRoot;
  }
  attachInternals() {
    if (this.__internals !== null) {
      throw new Error(`Failed to execute 'attachInternals' on 'HTMLElement': ElementInternals for the specified element was already attached.`);
    }
    const internals = new ElementInternalsShim(this);
    this.__internals = internals;
    return internals;
  }
  getAttribute(name) {
    const value = attributesForElement(this).get(name);
    return value ?? null;
  }
};
const ElementShimWithRealType = ElementShim;
const HTMLElementShim = class HTMLElement extends ElementShim {
};
const HTMLElementShimWithRealType = HTMLElementShim;
const ShadowRootShim = class ShadowRoot extends NodeShim {
  get host() {
    return this.__host;
  }
  constructor(constructionToken2, init) {
    super();
    if (constructionToken2 !== constructionToken2) {
      throw new TypeError("Illegal constructor");
    }
    this.mode = init.mode;
  }
};
globalThis.litServerRoot ?? (globalThis.litServerRoot = Object.defineProperty(new HTMLElementShimWithRealType(), "localName", {
  // Patch localName (and tagName) to return a unique name.
  get() {
    return "lit-server-root";
  }
}));
function promiseWithResolvers() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
class CustomElementRegistry {
  constructor() {
    this.__definitions = /* @__PURE__ */ new Map();
    this.__reverseDefinitions = /* @__PURE__ */ new Map();
    this.__pendingWhenDefineds = /* @__PURE__ */ new Map();
  }
  define(name, ctor) {
    var _a3;
    if (this.__definitions.has(name)) {
      if (process.env.NODE_ENV === "development") {
        console.warn(`'CustomElementRegistry' already has "${name}" defined. This may have been caused by live reload or hot module replacement in which case it can be safely ignored.
Make sure to test your application with a production build as repeat registrations will throw in production.`);
      } else {
        throw new Error(`Failed to execute 'define' on 'CustomElementRegistry': the name "${name}" has already been used with this registry`);
      }
    }
    if (this.__reverseDefinitions.has(ctor)) {
      throw new Error(`Failed to execute 'define' on 'CustomElementRegistry': the constructor has already been used with this registry for the tag name ${this.__reverseDefinitions.get(ctor)}`);
    }
    ctor.__localName = name;
    this.__definitions.set(name, {
      ctor,
      // Note it's important we read `observedAttributes` in case it is a getter
      // with side-effects, as is the case in Lit, where it triggers class
      // finalization.
      //
      // TODO(aomarks) To be spec compliant, we should also capture the
      // registration-time lifecycle methods like `connectedCallback`. For them
      // to be actually accessible to e.g. the Lit SSR element renderer, though,
      // we'd need to introduce a new API for accessing them (since `get` only
      // returns the constructor).
      observedAttributes: ctor.observedAttributes ?? []
    });
    this.__reverseDefinitions.set(ctor, name);
    (_a3 = this.__pendingWhenDefineds.get(name)) == null ? void 0 : _a3.resolve(ctor);
    this.__pendingWhenDefineds.delete(name);
  }
  get(name) {
    const definition = this.__definitions.get(name);
    return definition == null ? void 0 : definition.ctor;
  }
  getName(ctor) {
    return this.__reverseDefinitions.get(ctor) ?? null;
  }
  initialize(_root) {
    throw new Error(`customElements.initialize is not currently supported in SSR. Please file a bug if you need it.`);
  }
  upgrade(_element) {
    throw new Error(`customElements.upgrade is not currently supported in SSR. Please file a bug if you need it.`);
  }
  async whenDefined(name) {
    const definition = this.__definitions.get(name);
    if (definition) {
      return definition.ctor;
    }
    let withResolvers = this.__pendingWhenDefineds.get(name);
    if (!withResolvers) {
      withResolvers = promiseWithResolvers();
      this.__pendingWhenDefineds.set(name, withResolvers);
    }
    return withResolvers.promise;
  }
}
const CustomElementRegistryShimWithRealType = CustomElementRegistry;
const customElements = new CustomElementRegistryShimWithRealType();
const windowShim = new WindowShim(constructionToken);
/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const t$3 = globalThis, e$4 = t$3.ShadowRoot && (void 0 === t$3.ShadyCSS || t$3.ShadyCSS.nativeShadow) && "adoptedStyleSheets" in Document.prototype && "replace" in CSSStyleSheet.prototype, s$4 = Symbol(), o$6 = /* @__PURE__ */ new WeakMap();
let n$7 = class n {
  constructor(t2, e2, o2) {
    if (this._$cssResult$ = true, o2 !== s$4) throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");
    this.cssText = t2, this.t = e2;
  }
  get styleSheet() {
    let t2 = this.o;
    const s2 = this.t;
    if (e$4 && void 0 === t2) {
      const e2 = void 0 !== s2 && 1 === s2.length;
      e2 && (t2 = o$6.get(s2)), void 0 === t2 && ((this.o = t2 = new CSSStyleSheet()).replaceSync(this.cssText), e2 && o$6.set(s2, t2));
    }
    return t2;
  }
  toString() {
    return this.cssText;
  }
};
const r$5 = (t2) => new n$7("string" == typeof t2 ? t2 : t2 + "", void 0, s$4), S$2 = (s2, o2) => {
  if (e$4) s2.adoptedStyleSheets = o2.map((t2) => t2 instanceof CSSStyleSheet ? t2 : t2.styleSheet);
  else for (const e2 of o2) {
    const o3 = document.createElement("style"), n4 = t$3.litNonce;
    void 0 !== n4 && o3.setAttribute("nonce", n4), o3.textContent = e2.cssText, s2.appendChild(o3);
  }
}, c$4 = e$4 || void 0 === t$3.CSSStyleSheet ? (t2) => t2 : (t2) => t2 instanceof CSSStyleSheet ? ((t3) => {
  let e2 = "";
  for (const s2 of t3.cssRules) e2 += s2.cssText;
  return r$5(e2);
})(t2) : t2;
const { is: h$2, defineProperty: r$4, getOwnPropertyDescriptor: o$5, getOwnPropertyNames: n$6, getOwnPropertySymbols: a$3, getPrototypeOf: c$3 } = Object, l$4 = globalThis;
l$4.customElements ?? (l$4.customElements = customElements);
const p$2 = l$4.trustedTypes, d$3 = p$2 ? p$2.emptyScript : "", u$3 = l$4.reactiveElementPolyfillSupport, f$3 = (t2, s2) => t2, b$1 = { toAttribute(t2, s2) {
  switch (s2) {
    case Boolean:
      t2 = t2 ? d$3 : null;
      break;
    case Object:
    case Array:
      t2 = null == t2 ? t2 : JSON.stringify(t2);
  }
  return t2;
}, fromAttribute(t2, s2) {
  let i3 = t2;
  switch (s2) {
    case Boolean:
      i3 = null !== t2;
      break;
    case Number:
      i3 = null === t2 ? null : Number(t2);
      break;
    case Object:
    case Array:
      try {
        i3 = JSON.parse(t2);
      } catch (t3) {
        i3 = null;
      }
  }
  return i3;
} }, m$2 = (t2, s2) => !h$2(t2, s2), y$2 = { attribute: true, type: String, converter: b$1, reflect: false, useDefault: false, hasChanged: m$2 };
Symbol.metadata ?? (Symbol.metadata = Symbol("metadata")), l$4.litPropertyMetadata ?? (l$4.litPropertyMetadata = /* @__PURE__ */ new WeakMap());
let g$2 = class g extends (globalThis.HTMLElement ?? HTMLElementShimWithRealType) {
  static addInitializer(t2) {
    this._$Ei(), (this.l ?? (this.l = [])).push(t2);
  }
  static get observedAttributes() {
    return this.finalize(), this._$Eh && [...this._$Eh.keys()];
  }
  static createProperty(t2, s2 = y$2) {
    if (s2.state && (s2.attribute = false), this._$Ei(), this.prototype.hasOwnProperty(t2) && ((s2 = Object.create(s2)).wrapped = true), this.elementProperties.set(t2, s2), !s2.noAccessor) {
      const i3 = Symbol(), e2 = this.getPropertyDescriptor(t2, i3, s2);
      void 0 !== e2 && r$4(this.prototype, t2, e2);
    }
  }
  static getPropertyDescriptor(t2, s2, i3) {
    const { get: e2, set: h2 } = o$5(this.prototype, t2) ?? { get() {
      return this[s2];
    }, set(t3) {
      this[s2] = t3;
    } };
    return { get: e2, set(s3) {
      const r2 = e2 == null ? void 0 : e2.call(this);
      h2 == null ? void 0 : h2.call(this, s3), this.requestUpdate(t2, r2, i3);
    }, configurable: true, enumerable: true };
  }
  static getPropertyOptions(t2) {
    return this.elementProperties.get(t2) ?? y$2;
  }
  static _$Ei() {
    if (this.hasOwnProperty(f$3("elementProperties"))) return;
    const t2 = c$3(this);
    t2.finalize(), void 0 !== t2.l && (this.l = [...t2.l]), this.elementProperties = new Map(t2.elementProperties);
  }
  static finalize() {
    if (this.hasOwnProperty(f$3("finalized"))) return;
    if (this.finalized = true, this._$Ei(), this.hasOwnProperty(f$3("properties"))) {
      const t3 = this.properties, s2 = [...n$6(t3), ...a$3(t3)];
      for (const i3 of s2) this.createProperty(i3, t3[i3]);
    }
    const t2 = this[Symbol.metadata];
    if (null !== t2) {
      const s2 = litPropertyMetadata.get(t2);
      if (void 0 !== s2) for (const [t3, i3] of s2) this.elementProperties.set(t3, i3);
    }
    this._$Eh = /* @__PURE__ */ new Map();
    for (const [t3, s2] of this.elementProperties) {
      const i3 = this._$Eu(t3, s2);
      void 0 !== i3 && this._$Eh.set(i3, t3);
    }
    this.elementStyles = this.finalizeStyles(this.styles);
  }
  static finalizeStyles(t2) {
    const s2 = [];
    if (Array.isArray(t2)) {
      const e2 = new Set(t2.flat(1 / 0).reverse());
      for (const t3 of e2) s2.unshift(c$4(t3));
    } else void 0 !== t2 && s2.push(c$4(t2));
    return s2;
  }
  static _$Eu(t2, s2) {
    const i3 = s2.attribute;
    return false === i3 ? void 0 : "string" == typeof i3 ? i3 : "string" == typeof t2 ? t2.toLowerCase() : void 0;
  }
  constructor() {
    super(), this._$Ep = void 0, this.isUpdatePending = false, this.hasUpdated = false, this._$Em = null, this._$Ev();
  }
  _$Ev() {
    var _a3;
    this._$ES = new Promise((t2) => this.enableUpdating = t2), this._$AL = /* @__PURE__ */ new Map(), this._$E_(), this.requestUpdate(), (_a3 = this.constructor.l) == null ? void 0 : _a3.forEach((t2) => t2(this));
  }
  addController(t2) {
    var _a3;
    (this._$EO ?? (this._$EO = /* @__PURE__ */ new Set())).add(t2), void 0 !== this.renderRoot && this.isConnected && ((_a3 = t2.hostConnected) == null ? void 0 : _a3.call(t2));
  }
  removeController(t2) {
    var _a3;
    (_a3 = this._$EO) == null ? void 0 : _a3.delete(t2);
  }
  _$E_() {
    const t2 = /* @__PURE__ */ new Map(), s2 = this.constructor.elementProperties;
    for (const i3 of s2.keys()) this.hasOwnProperty(i3) && (t2.set(i3, this[i3]), delete this[i3]);
    t2.size > 0 && (this._$Ep = t2);
  }
  createRenderRoot() {
    const t2 = this.shadowRoot ?? this.attachShadow(this.constructor.shadowRootOptions);
    return S$2(t2, this.constructor.elementStyles), t2;
  }
  connectedCallback() {
    var _a3;
    this.renderRoot ?? (this.renderRoot = this.createRenderRoot()), this.enableUpdating(true), (_a3 = this._$EO) == null ? void 0 : _a3.forEach((t2) => {
      var _a4;
      return (_a4 = t2.hostConnected) == null ? void 0 : _a4.call(t2);
    });
  }
  enableUpdating(t2) {
  }
  disconnectedCallback() {
    var _a3;
    (_a3 = this._$EO) == null ? void 0 : _a3.forEach((t2) => {
      var _a4;
      return (_a4 = t2.hostDisconnected) == null ? void 0 : _a4.call(t2);
    });
  }
  attributeChangedCallback(t2, s2, i3) {
    this._$AK(t2, i3);
  }
  _$ET(t2, s2) {
    var _a3;
    const i3 = this.constructor.elementProperties.get(t2), e2 = this.constructor._$Eu(t2, i3);
    if (void 0 !== e2 && true === i3.reflect) {
      const h2 = (void 0 !== ((_a3 = i3.converter) == null ? void 0 : _a3.toAttribute) ? i3.converter : b$1).toAttribute(s2, i3.type);
      this._$Em = t2, null == h2 ? this.removeAttribute(e2) : this.setAttribute(e2, h2), this._$Em = null;
    }
  }
  _$AK(t2, s2) {
    var _a3, _b2;
    const i3 = this.constructor, e2 = i3._$Eh.get(t2);
    if (void 0 !== e2 && this._$Em !== e2) {
      const t3 = i3.getPropertyOptions(e2), h2 = "function" == typeof t3.converter ? { fromAttribute: t3.converter } : void 0 !== ((_a3 = t3.converter) == null ? void 0 : _a3.fromAttribute) ? t3.converter : b$1;
      this._$Em = e2;
      const r2 = h2.fromAttribute(s2, t3.type);
      this[e2] = r2 ?? ((_b2 = this._$Ej) == null ? void 0 : _b2.get(e2)) ?? r2, this._$Em = null;
    }
  }
  requestUpdate(t2, s2, i3, e2 = false, h2) {
    var _a3;
    if (void 0 !== t2) {
      const r2 = this.constructor;
      if (false === e2 && (h2 = this[t2]), i3 ?? (i3 = r2.getPropertyOptions(t2)), !((i3.hasChanged ?? m$2)(h2, s2) || i3.useDefault && i3.reflect && h2 === ((_a3 = this._$Ej) == null ? void 0 : _a3.get(t2)) && !this.hasAttribute(r2._$Eu(t2, i3)))) return;
      this.C(t2, s2, i3);
    }
    false === this.isUpdatePending && (this._$ES = this._$EP());
  }
  C(t2, s2, { useDefault: i3, reflect: e2, wrapped: h2 }, r2) {
    i3 && !(this._$Ej ?? (this._$Ej = /* @__PURE__ */ new Map())).has(t2) && (this._$Ej.set(t2, r2 ?? s2 ?? this[t2]), true !== h2 || void 0 !== r2) || (this._$AL.has(t2) || (this.hasUpdated || i3 || (s2 = void 0), this._$AL.set(t2, s2)), true === e2 && this._$Em !== t2 && (this._$Eq ?? (this._$Eq = /* @__PURE__ */ new Set())).add(t2));
  }
  async _$EP() {
    this.isUpdatePending = true;
    try {
      await this._$ES;
    } catch (t3) {
      Promise.reject(t3);
    }
    const t2 = this.scheduleUpdate();
    return null != t2 && await t2, !this.isUpdatePending;
  }
  scheduleUpdate() {
    return this.performUpdate();
  }
  performUpdate() {
    var _a3;
    if (!this.isUpdatePending) return;
    if (!this.hasUpdated) {
      if (this.renderRoot ?? (this.renderRoot = this.createRenderRoot()), this._$Ep) {
        for (const [t4, s3] of this._$Ep) this[t4] = s3;
        this._$Ep = void 0;
      }
      const t3 = this.constructor.elementProperties;
      if (t3.size > 0) for (const [s3, i3] of t3) {
        const { wrapped: t4 } = i3, e2 = this[s3];
        true !== t4 || this._$AL.has(s3) || void 0 === e2 || this.C(s3, void 0, i3, e2);
      }
    }
    let t2 = false;
    const s2 = this._$AL;
    try {
      t2 = this.shouldUpdate(s2), t2 ? (this.willUpdate(s2), (_a3 = this._$EO) == null ? void 0 : _a3.forEach((t3) => {
        var _a4;
        return (_a4 = t3.hostUpdate) == null ? void 0 : _a4.call(t3);
      }), this.update(s2)) : this._$EM();
    } catch (s3) {
      throw t2 = false, this._$EM(), s3;
    }
    t2 && this._$AE(s2);
  }
  willUpdate(t2) {
  }
  _$AE(t2) {
    var _a3;
    (_a3 = this._$EO) == null ? void 0 : _a3.forEach((t3) => {
      var _a4;
      return (_a4 = t3.hostUpdated) == null ? void 0 : _a4.call(t3);
    }), this.hasUpdated || (this.hasUpdated = true, this.firstUpdated(t2)), this.updated(t2);
  }
  _$EM() {
    this._$AL = /* @__PURE__ */ new Map(), this.isUpdatePending = false;
  }
  get updateComplete() {
    return this.getUpdateComplete();
  }
  getUpdateComplete() {
    return this._$ES;
  }
  shouldUpdate(t2) {
    return true;
  }
  update(t2) {
    this._$Eq && (this._$Eq = this._$Eq.forEach((t3) => this._$ET(t3, this[t3]))), this._$EM();
  }
  updated(t2) {
  }
  firstUpdated(t2) {
  }
};
g$2.elementStyles = [], g$2.shadowRootOptions = { mode: "open" }, g$2[f$3("elementProperties")] = /* @__PURE__ */ new Map(), g$2[f$3("finalized")] = /* @__PURE__ */ new Map(), u$3 == null ? void 0 : u$3({ ReactiveElement: g$2 }), (l$4.reactiveElementVersions ?? (l$4.reactiveElementVersions = [])).push("2.1.2");
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const t$2 = globalThis, i$3 = (t2) => t2, s$3 = t$2.trustedTypes, e$3 = s$3 ? s$3.createPolicy("lit-html", { createHTML: (t2) => t2 }) : void 0, h$1 = "$lit$", o$4 = `lit$${Math.random().toFixed(9).slice(2)}$`, n$5 = "?" + o$4, r$3 = `<${n$5}>`, l$3 = void 0 === t$2.document ? { createTreeWalker: () => ({}) } : document, c$2 = () => l$3.createComment(""), a$2 = (t2) => null === t2 || "object" != typeof t2 && "function" != typeof t2, u$2 = Array.isArray, d$2 = (t2) => u$2(t2) || "function" == typeof (t2 == null ? void 0 : t2[Symbol.iterator]), f$2 = "[ 	\n\f\r]", v = /<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g, _ = /-->/g, m$1 = />/g, p$1 = RegExp(`>|${f$2}(?:([^\\s"'>=/]+)(${f$2}*=${f$2}*(?:[^ 	
\f\r"'\`<>=]|("|')|))|$)`, "g"), g$1 = /'/g, $ = /"/g, y$1 = /^(?:script|style|textarea|title)$/i, x = (t2) => (i3, ...s2) => ({ _$litType$: t2, strings: i3, values: s2 }), T = x(1), E = Symbol.for("lit-noChange"), A = Symbol.for("lit-nothing"), C = /* @__PURE__ */ new WeakMap(), P = l$3.createTreeWalker(l$3, 129);
function V(t2, i3) {
  if (!u$2(t2) || !t2.hasOwnProperty("raw")) throw Error("invalid template strings array");
  return void 0 !== e$3 ? e$3.createHTML(i3) : i3;
}
const N = (t2, i3) => {
  const s2 = t2.length - 1, e2 = [];
  let n4, l2 = 2 === i3 ? "<svg>" : 3 === i3 ? "<math>" : "", c2 = v;
  for (let i4 = 0; i4 < s2; i4++) {
    const s3 = t2[i4];
    let a2, u2, d2 = -1, f2 = 0;
    for (; f2 < s3.length && (c2.lastIndex = f2, u2 = c2.exec(s3), null !== u2); ) f2 = c2.lastIndex, c2 === v ? "!--" === u2[1] ? c2 = _ : void 0 !== u2[1] ? c2 = m$1 : void 0 !== u2[2] ? (y$1.test(u2[2]) && (n4 = RegExp("</" + u2[2], "g")), c2 = p$1) : void 0 !== u2[3] && (c2 = p$1) : c2 === p$1 ? ">" === u2[0] ? (c2 = n4 ?? v, d2 = -1) : void 0 === u2[1] ? d2 = -2 : (d2 = c2.lastIndex - u2[2].length, a2 = u2[1], c2 = void 0 === u2[3] ? p$1 : '"' === u2[3] ? $ : g$1) : c2 === $ || c2 === g$1 ? c2 = p$1 : c2 === _ || c2 === m$1 ? c2 = v : (c2 = p$1, n4 = void 0);
    const x2 = c2 === p$1 && t2[i4 + 1].startsWith("/>") ? " " : "";
    l2 += c2 === v ? s3 + r$3 : d2 >= 0 ? (e2.push(a2), s3.slice(0, d2) + h$1 + s3.slice(d2) + o$4 + x2) : s3 + o$4 + (-2 === d2 ? i4 : x2);
  }
  return [V(t2, l2 + (t2[s2] || "<?>") + (2 === i3 ? "</svg>" : 3 === i3 ? "</math>" : "")), e2];
};
let S$1 = class S {
  constructor({ strings: t2, _$litType$: i3 }, e2) {
    let r2;
    this.parts = [];
    let l2 = 0, a2 = 0;
    const u2 = t2.length - 1, d2 = this.parts, [f2, v2] = N(t2, i3);
    if (this.el = S.createElement(f2, e2), P.currentNode = this.el.content, 2 === i3 || 3 === i3) {
      const t3 = this.el.content.firstChild;
      t3.replaceWith(...t3.childNodes);
    }
    for (; null !== (r2 = P.nextNode()) && d2.length < u2; ) {
      if (1 === r2.nodeType) {
        if (r2.hasAttributes()) for (const t3 of r2.getAttributeNames()) if (t3.endsWith(h$1)) {
          const i4 = v2[a2++], s2 = r2.getAttribute(t3).split(o$4), e3 = /([.?@])?(.*)/.exec(i4);
          d2.push({ type: 1, index: l2, name: e3[2], strings: s2, ctor: "." === e3[1] ? I : "?" === e3[1] ? L : "@" === e3[1] ? z : H }), r2.removeAttribute(t3);
        } else t3.startsWith(o$4) && (d2.push({ type: 6, index: l2 }), r2.removeAttribute(t3));
        if (y$1.test(r2.tagName)) {
          const t3 = r2.textContent.split(o$4), i4 = t3.length - 1;
          if (i4 > 0) {
            r2.textContent = s$3 ? s$3.emptyScript : "";
            for (let s2 = 0; s2 < i4; s2++) r2.append(t3[s2], c$2()), P.nextNode(), d2.push({ type: 2, index: ++l2 });
            r2.append(t3[i4], c$2());
          }
        }
      } else if (8 === r2.nodeType) if (r2.data === n$5) d2.push({ type: 2, index: l2 });
      else {
        let t3 = -1;
        for (; -1 !== (t3 = r2.data.indexOf(o$4, t3 + 1)); ) d2.push({ type: 7, index: l2 }), t3 += o$4.length - 1;
      }
      l2++;
    }
  }
  static createElement(t2, i3) {
    const s2 = l$3.createElement("template");
    return s2.innerHTML = t2, s2;
  }
};
function M(t2, i3, s2 = t2, e2) {
  var _a3, _b2;
  if (i3 === E) return i3;
  let h2 = void 0 !== e2 ? (_a3 = s2._$Co) == null ? void 0 : _a3[e2] : s2._$Cl;
  const o2 = a$2(i3) ? void 0 : i3._$litDirective$;
  return (h2 == null ? void 0 : h2.constructor) !== o2 && ((_b2 = h2 == null ? void 0 : h2._$AO) == null ? void 0 : _b2.call(h2, false), void 0 === o2 ? h2 = void 0 : (h2 = new o2(t2), h2._$AT(t2, s2, e2)), void 0 !== e2 ? (s2._$Co ?? (s2._$Co = []))[e2] = h2 : s2._$Cl = h2), void 0 !== h2 && (i3 = M(t2, h2._$AS(t2, i3.values), h2, e2)), i3;
}
class k {
  constructor(t2, i3) {
    this._$AV = [], this._$AN = void 0, this._$AD = t2, this._$AM = i3;
  }
  get parentNode() {
    return this._$AM.parentNode;
  }
  get _$AU() {
    return this._$AM._$AU;
  }
  u(t2) {
    const { el: { content: i3 }, parts: s2 } = this._$AD, e2 = ((t2 == null ? void 0 : t2.creationScope) ?? l$3).importNode(i3, true);
    P.currentNode = e2;
    let h2 = P.nextNode(), o2 = 0, n4 = 0, r2 = s2[0];
    for (; void 0 !== r2; ) {
      if (o2 === r2.index) {
        let i4;
        2 === r2.type ? i4 = new R(h2, h2.nextSibling, this, t2) : 1 === r2.type ? i4 = new r2.ctor(h2, r2.name, r2.strings, this, t2) : 6 === r2.type && (i4 = new W(h2, this, t2)), this._$AV.push(i4), r2 = s2[++n4];
      }
      o2 !== (r2 == null ? void 0 : r2.index) && (h2 = P.nextNode(), o2++);
    }
    return P.currentNode = l$3, e2;
  }
  p(t2) {
    let i3 = 0;
    for (const s2 of this._$AV) void 0 !== s2 && (void 0 !== s2.strings ? (s2._$AI(t2, s2, i3), i3 += s2.strings.length - 2) : s2._$AI(t2[i3])), i3++;
  }
}
class R {
  get _$AU() {
    var _a3;
    return ((_a3 = this._$AM) == null ? void 0 : _a3._$AU) ?? this._$Cv;
  }
  constructor(t2, i3, s2, e2) {
    this.type = 2, this._$AH = A, this._$AN = void 0, this._$AA = t2, this._$AB = i3, this._$AM = s2, this.options = e2, this._$Cv = (e2 == null ? void 0 : e2.isConnected) ?? true;
  }
  get parentNode() {
    let t2 = this._$AA.parentNode;
    const i3 = this._$AM;
    return void 0 !== i3 && 11 === (t2 == null ? void 0 : t2.nodeType) && (t2 = i3.parentNode), t2;
  }
  get startNode() {
    return this._$AA;
  }
  get endNode() {
    return this._$AB;
  }
  _$AI(t2, i3 = this) {
    t2 = M(this, t2, i3), a$2(t2) ? t2 === A || null == t2 || "" === t2 ? (this._$AH !== A && this._$AR(), this._$AH = A) : t2 !== this._$AH && t2 !== E && this._(t2) : void 0 !== t2._$litType$ ? this.$(t2) : void 0 !== t2.nodeType ? this.T(t2) : d$2(t2) ? this.k(t2) : this._(t2);
  }
  O(t2) {
    return this._$AA.parentNode.insertBefore(t2, this._$AB);
  }
  T(t2) {
    this._$AH !== t2 && (this._$AR(), this._$AH = this.O(t2));
  }
  _(t2) {
    this._$AH !== A && a$2(this._$AH) ? this._$AA.nextSibling.data = t2 : this.T(l$3.createTextNode(t2)), this._$AH = t2;
  }
  $(t2) {
    var _a3;
    const { values: i3, _$litType$: s2 } = t2, e2 = "number" == typeof s2 ? this._$AC(t2) : (void 0 === s2.el && (s2.el = S$1.createElement(V(s2.h, s2.h[0]), this.options)), s2);
    if (((_a3 = this._$AH) == null ? void 0 : _a3._$AD) === e2) this._$AH.p(i3);
    else {
      const t3 = new k(e2, this), s3 = t3.u(this.options);
      t3.p(i3), this.T(s3), this._$AH = t3;
    }
  }
  _$AC(t2) {
    let i3 = C.get(t2.strings);
    return void 0 === i3 && C.set(t2.strings, i3 = new S$1(t2)), i3;
  }
  k(t2) {
    u$2(this._$AH) || (this._$AH = [], this._$AR());
    const i3 = this._$AH;
    let s2, e2 = 0;
    for (const h2 of t2) e2 === i3.length ? i3.push(s2 = new R(this.O(c$2()), this.O(c$2()), this, this.options)) : s2 = i3[e2], s2._$AI(h2), e2++;
    e2 < i3.length && (this._$AR(s2 && s2._$AB.nextSibling, e2), i3.length = e2);
  }
  _$AR(t2 = this._$AA.nextSibling, s2) {
    var _a3;
    for ((_a3 = this._$AP) == null ? void 0 : _a3.call(this, false, true, s2); t2 !== this._$AB; ) {
      const s3 = i$3(t2).nextSibling;
      i$3(t2).remove(), t2 = s3;
    }
  }
  setConnected(t2) {
    var _a3;
    void 0 === this._$AM && (this._$Cv = t2, (_a3 = this._$AP) == null ? void 0 : _a3.call(this, t2));
  }
}
class H {
  get tagName() {
    return this.element.tagName;
  }
  get _$AU() {
    return this._$AM._$AU;
  }
  constructor(t2, i3, s2, e2, h2) {
    this.type = 1, this._$AH = A, this._$AN = void 0, this.element = t2, this.name = i3, this._$AM = e2, this.options = h2, s2.length > 2 || "" !== s2[0] || "" !== s2[1] ? (this._$AH = Array(s2.length - 1).fill(new String()), this.strings = s2) : this._$AH = A;
  }
  _$AI(t2, i3 = this, s2, e2) {
    const h2 = this.strings;
    let o2 = false;
    if (void 0 === h2) t2 = M(this, t2, i3, 0), o2 = !a$2(t2) || t2 !== this._$AH && t2 !== E, o2 && (this._$AH = t2);
    else {
      const e3 = t2;
      let n4, r2;
      for (t2 = h2[0], n4 = 0; n4 < h2.length - 1; n4++) r2 = M(this, e3[s2 + n4], i3, n4), r2 === E && (r2 = this._$AH[n4]), o2 || (o2 = !a$2(r2) || r2 !== this._$AH[n4]), r2 === A ? t2 = A : t2 !== A && (t2 += (r2 ?? "") + h2[n4 + 1]), this._$AH[n4] = r2;
    }
    o2 && !e2 && this.j(t2);
  }
  j(t2) {
    t2 === A ? this.element.removeAttribute(this.name) : this.element.setAttribute(this.name, t2 ?? "");
  }
}
class I extends H {
  constructor() {
    super(...arguments), this.type = 3;
  }
  j(t2) {
    this.element[this.name] = t2 === A ? void 0 : t2;
  }
}
class L extends H {
  constructor() {
    super(...arguments), this.type = 4;
  }
  j(t2) {
    this.element.toggleAttribute(this.name, !!t2 && t2 !== A);
  }
}
class z extends H {
  constructor(t2, i3, s2, e2, h2) {
    super(t2, i3, s2, e2, h2), this.type = 5;
  }
  _$AI(t2, i3 = this) {
    if ((t2 = M(this, t2, i3, 0) ?? A) === E) return;
    const s2 = this._$AH, e2 = t2 === A && s2 !== A || t2.capture !== s2.capture || t2.once !== s2.once || t2.passive !== s2.passive, h2 = t2 !== A && (s2 === A || e2);
    e2 && this.element.removeEventListener(this.name, this, s2), h2 && this.element.addEventListener(this.name, this, t2), this._$AH = t2;
  }
  handleEvent(t2) {
    var _a3;
    "function" == typeof this._$AH ? this._$AH.call(((_a3 = this.options) == null ? void 0 : _a3.host) ?? this.element, t2) : this._$AH.handleEvent(t2);
  }
}
class W {
  constructor(t2, i3, s2) {
    this.element = t2, this.type = 6, this._$AN = void 0, this._$AM = i3, this.options = s2;
  }
  get _$AU() {
    return this._$AM._$AU;
  }
  _$AI(t2) {
    M(this, t2);
  }
}
const Z = { M: h$1, P: o$4, A: n$5, L: N, D: d$2, V: M, H, N: L, U: z, B: I }, j = t$2.litHtmlPolyfillSupport;
j == null ? void 0 : j(S$1, R), (t$2.litHtmlVersions ?? (t$2.litHtmlVersions = [])).push("3.3.3");
const B = (t2, i3, s2) => {
  const e2 = (s2 == null ? void 0 : s2.renderBefore) ?? i3;
  let h2 = e2._$litPart$;
  if (void 0 === h2) {
    const t3 = (s2 == null ? void 0 : s2.renderBefore) ?? null;
    e2._$litPart$ = h2 = new R(i3.insertBefore(c$2(), t3), t3, void 0, s2 ?? {});
  }
  return h2._$AI(t2), h2;
};
/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const t$1 = globalThis, e$2 = t$1.ShadowRoot && (void 0 === t$1.ShadyCSS || t$1.ShadyCSS.nativeShadow) && "adoptedStyleSheets" in Document.prototype && "replace" in CSSStyleSheet.prototype, s$2 = Symbol(), o$3 = /* @__PURE__ */ new WeakMap();
let n$4 = class n2 {
  constructor(t2, e2, o2) {
    if (this._$cssResult$ = true, o2 !== s$2) throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");
    this.cssText = t2, this.t = e2;
  }
  get styleSheet() {
    let t2 = this.o;
    const s2 = this.t;
    if (e$2 && void 0 === t2) {
      const e2 = void 0 !== s2 && 1 === s2.length;
      e2 && (t2 = o$3.get(s2)), void 0 === t2 && ((this.o = t2 = new CSSStyleSheet()).replaceSync(this.cssText), e2 && o$3.set(s2, t2));
    }
    return t2;
  }
  toString() {
    return this.cssText;
  }
};
const r$2 = (t2) => new n$4("string" == typeof t2 ? t2 : t2 + "", void 0, s$2), i$2 = (t2, ...e2) => {
  const o2 = 1 === t2.length ? t2[0] : e2.reduce((e3, s2, o3) => e3 + ((t3) => {
    if (true === t3._$cssResult$) return t3.cssText;
    if ("number" == typeof t3) return t3;
    throw Error("Value passed to 'css' function must be a 'css' function result: " + t3 + ". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.");
  })(s2) + t2[o3 + 1], t2[0]);
  return new n$4(o2, t2, s$2);
}, S2 = (s2, o2) => {
  if (e$2) s2.adoptedStyleSheets = o2.map((t2) => t2 instanceof CSSStyleSheet ? t2 : t2.styleSheet);
  else for (const e2 of o2) {
    const o3 = document.createElement("style"), n4 = t$1.litNonce;
    void 0 !== n4 && o3.setAttribute("nonce", n4), o3.textContent = e2.cssText, s2.appendChild(o3);
  }
}, c$1 = e$2 || void 0 === t$1.CSSStyleSheet ? (t2) => t2 : (t2) => t2 instanceof CSSStyleSheet ? ((t3) => {
  let e2 = "";
  for (const s2 of t3.cssRules) e2 += s2.cssText;
  return r$2(e2);
})(t2) : t2;
const { is: h, defineProperty: r$1, getOwnPropertyDescriptor: o$2, getOwnPropertyNames: n$3, getOwnPropertySymbols: a$1, getPrototypeOf: c } = Object, l$2 = globalThis;
l$2.customElements ?? (l$2.customElements = customElements);
const p = l$2.trustedTypes, d$1 = p ? p.emptyScript : "", u$1 = l$2.reactiveElementPolyfillSupport, f$1 = (t2, s2) => t2, b = { toAttribute(t2, s2) {
  switch (s2) {
    case Boolean:
      t2 = t2 ? d$1 : null;
      break;
    case Object:
    case Array:
      t2 = null == t2 ? t2 : JSON.stringify(t2);
  }
  return t2;
}, fromAttribute(t2, s2) {
  let i3 = t2;
  switch (s2) {
    case Boolean:
      i3 = null !== t2;
      break;
    case Number:
      i3 = null === t2 ? null : Number(t2);
      break;
    case Object:
    case Array:
      try {
        i3 = JSON.parse(t2);
      } catch (t3) {
        i3 = null;
      }
  }
  return i3;
} }, m = (t2, s2) => !h(t2, s2), y = { attribute: true, type: String, converter: b, reflect: false, useDefault: false, hasChanged: m };
Symbol.metadata ?? (Symbol.metadata = Symbol("metadata")), l$2.litPropertyMetadata ?? (l$2.litPropertyMetadata = /* @__PURE__ */ new WeakMap());
class g2 extends (globalThis.HTMLElement ?? HTMLElementShimWithRealType) {
  static addInitializer(t2) {
    this._$Ei(), (this.l ?? (this.l = [])).push(t2);
  }
  static get observedAttributes() {
    return this.finalize(), this._$Eh && [...this._$Eh.keys()];
  }
  static createProperty(t2, s2 = y) {
    if (s2.state && (s2.attribute = false), this._$Ei(), this.prototype.hasOwnProperty(t2) && ((s2 = Object.create(s2)).wrapped = true), this.elementProperties.set(t2, s2), !s2.noAccessor) {
      const i3 = Symbol(), e2 = this.getPropertyDescriptor(t2, i3, s2);
      void 0 !== e2 && r$1(this.prototype, t2, e2);
    }
  }
  static getPropertyDescriptor(t2, s2, i3) {
    const { get: e2, set: h2 } = o$2(this.prototype, t2) ?? { get() {
      return this[s2];
    }, set(t3) {
      this[s2] = t3;
    } };
    return { get: e2, set(s3) {
      const r2 = e2 == null ? void 0 : e2.call(this);
      h2 == null ? void 0 : h2.call(this, s3), this.requestUpdate(t2, r2, i3);
    }, configurable: true, enumerable: true };
  }
  static getPropertyOptions(t2) {
    return this.elementProperties.get(t2) ?? y;
  }
  static _$Ei() {
    if (this.hasOwnProperty(f$1("elementProperties"))) return;
    const t2 = c(this);
    t2.finalize(), void 0 !== t2.l && (this.l = [...t2.l]), this.elementProperties = new Map(t2.elementProperties);
  }
  static finalize() {
    if (this.hasOwnProperty(f$1("finalized"))) return;
    if (this.finalized = true, this._$Ei(), this.hasOwnProperty(f$1("properties"))) {
      const t3 = this.properties, s2 = [...n$3(t3), ...a$1(t3)];
      for (const i3 of s2) this.createProperty(i3, t3[i3]);
    }
    const t2 = this[Symbol.metadata];
    if (null !== t2) {
      const s2 = litPropertyMetadata.get(t2);
      if (void 0 !== s2) for (const [t3, i3] of s2) this.elementProperties.set(t3, i3);
    }
    this._$Eh = /* @__PURE__ */ new Map();
    for (const [t3, s2] of this.elementProperties) {
      const i3 = this._$Eu(t3, s2);
      void 0 !== i3 && this._$Eh.set(i3, t3);
    }
    this.elementStyles = this.finalizeStyles(this.styles);
  }
  static finalizeStyles(t2) {
    const s2 = [];
    if (Array.isArray(t2)) {
      const e2 = new Set(t2.flat(1 / 0).reverse());
      for (const t3 of e2) s2.unshift(c$1(t3));
    } else void 0 !== t2 && s2.push(c$1(t2));
    return s2;
  }
  static _$Eu(t2, s2) {
    const i3 = s2.attribute;
    return false === i3 ? void 0 : "string" == typeof i3 ? i3 : "string" == typeof t2 ? t2.toLowerCase() : void 0;
  }
  constructor() {
    super(), this._$Ep = void 0, this.isUpdatePending = false, this.hasUpdated = false, this._$Em = null, this._$Ev();
  }
  _$Ev() {
    var _a3;
    this._$ES = new Promise((t2) => this.enableUpdating = t2), this._$AL = /* @__PURE__ */ new Map(), this._$E_(), this.requestUpdate(), (_a3 = this.constructor.l) == null ? void 0 : _a3.forEach((t2) => t2(this));
  }
  addController(t2) {
    var _a3;
    (this._$EO ?? (this._$EO = /* @__PURE__ */ new Set())).add(t2), void 0 !== this.renderRoot && this.isConnected && ((_a3 = t2.hostConnected) == null ? void 0 : _a3.call(t2));
  }
  removeController(t2) {
    var _a3;
    (_a3 = this._$EO) == null ? void 0 : _a3.delete(t2);
  }
  _$E_() {
    const t2 = /* @__PURE__ */ new Map(), s2 = this.constructor.elementProperties;
    for (const i3 of s2.keys()) this.hasOwnProperty(i3) && (t2.set(i3, this[i3]), delete this[i3]);
    t2.size > 0 && (this._$Ep = t2);
  }
  createRenderRoot() {
    const t2 = this.shadowRoot ?? this.attachShadow(this.constructor.shadowRootOptions);
    return S2(t2, this.constructor.elementStyles), t2;
  }
  connectedCallback() {
    var _a3;
    this.renderRoot ?? (this.renderRoot = this.createRenderRoot()), this.enableUpdating(true), (_a3 = this._$EO) == null ? void 0 : _a3.forEach((t2) => {
      var _a4;
      return (_a4 = t2.hostConnected) == null ? void 0 : _a4.call(t2);
    });
  }
  enableUpdating(t2) {
  }
  disconnectedCallback() {
    var _a3;
    (_a3 = this._$EO) == null ? void 0 : _a3.forEach((t2) => {
      var _a4;
      return (_a4 = t2.hostDisconnected) == null ? void 0 : _a4.call(t2);
    });
  }
  attributeChangedCallback(t2, s2, i3) {
    this._$AK(t2, i3);
  }
  _$ET(t2, s2) {
    var _a3;
    const i3 = this.constructor.elementProperties.get(t2), e2 = this.constructor._$Eu(t2, i3);
    if (void 0 !== e2 && true === i3.reflect) {
      const h2 = (void 0 !== ((_a3 = i3.converter) == null ? void 0 : _a3.toAttribute) ? i3.converter : b).toAttribute(s2, i3.type);
      this._$Em = t2, null == h2 ? this.removeAttribute(e2) : this.setAttribute(e2, h2), this._$Em = null;
    }
  }
  _$AK(t2, s2) {
    var _a3, _b2;
    const i3 = this.constructor, e2 = i3._$Eh.get(t2);
    if (void 0 !== e2 && this._$Em !== e2) {
      const t3 = i3.getPropertyOptions(e2), h2 = "function" == typeof t3.converter ? { fromAttribute: t3.converter } : void 0 !== ((_a3 = t3.converter) == null ? void 0 : _a3.fromAttribute) ? t3.converter : b;
      this._$Em = e2;
      const r2 = h2.fromAttribute(s2, t3.type);
      this[e2] = r2 ?? ((_b2 = this._$Ej) == null ? void 0 : _b2.get(e2)) ?? r2, this._$Em = null;
    }
  }
  requestUpdate(t2, s2, i3, e2 = false, h2) {
    var _a3;
    if (void 0 !== t2) {
      const r2 = this.constructor;
      if (false === e2 && (h2 = this[t2]), i3 ?? (i3 = r2.getPropertyOptions(t2)), !((i3.hasChanged ?? m)(h2, s2) || i3.useDefault && i3.reflect && h2 === ((_a3 = this._$Ej) == null ? void 0 : _a3.get(t2)) && !this.hasAttribute(r2._$Eu(t2, i3)))) return;
      this.C(t2, s2, i3);
    }
    false === this.isUpdatePending && (this._$ES = this._$EP());
  }
  C(t2, s2, { useDefault: i3, reflect: e2, wrapped: h2 }, r2) {
    i3 && !(this._$Ej ?? (this._$Ej = /* @__PURE__ */ new Map())).has(t2) && (this._$Ej.set(t2, r2 ?? s2 ?? this[t2]), true !== h2 || void 0 !== r2) || (this._$AL.has(t2) || (this.hasUpdated || i3 || (s2 = void 0), this._$AL.set(t2, s2)), true === e2 && this._$Em !== t2 && (this._$Eq ?? (this._$Eq = /* @__PURE__ */ new Set())).add(t2));
  }
  async _$EP() {
    this.isUpdatePending = true;
    try {
      await this._$ES;
    } catch (t3) {
      Promise.reject(t3);
    }
    const t2 = this.scheduleUpdate();
    return null != t2 && await t2, !this.isUpdatePending;
  }
  scheduleUpdate() {
    return this.performUpdate();
  }
  performUpdate() {
    var _a3;
    if (!this.isUpdatePending) return;
    if (!this.hasUpdated) {
      if (this.renderRoot ?? (this.renderRoot = this.createRenderRoot()), this._$Ep) {
        for (const [t4, s3] of this._$Ep) this[t4] = s3;
        this._$Ep = void 0;
      }
      const t3 = this.constructor.elementProperties;
      if (t3.size > 0) for (const [s3, i3] of t3) {
        const { wrapped: t4 } = i3, e2 = this[s3];
        true !== t4 || this._$AL.has(s3) || void 0 === e2 || this.C(s3, void 0, i3, e2);
      }
    }
    let t2 = false;
    const s2 = this._$AL;
    try {
      t2 = this.shouldUpdate(s2), t2 ? (this.willUpdate(s2), (_a3 = this._$EO) == null ? void 0 : _a3.forEach((t3) => {
        var _a4;
        return (_a4 = t3.hostUpdate) == null ? void 0 : _a4.call(t3);
      }), this.update(s2)) : this._$EM();
    } catch (s3) {
      throw t2 = false, this._$EM(), s3;
    }
    t2 && this._$AE(s2);
  }
  willUpdate(t2) {
  }
  _$AE(t2) {
    var _a3;
    (_a3 = this._$EO) == null ? void 0 : _a3.forEach((t3) => {
      var _a4;
      return (_a4 = t3.hostUpdated) == null ? void 0 : _a4.call(t3);
    }), this.hasUpdated || (this.hasUpdated = true, this.firstUpdated(t2)), this.updated(t2);
  }
  _$EM() {
    this._$AL = /* @__PURE__ */ new Map(), this.isUpdatePending = false;
  }
  get updateComplete() {
    return this.getUpdateComplete();
  }
  getUpdateComplete() {
    return this._$ES;
  }
  shouldUpdate(t2) {
    return true;
  }
  update(t2) {
    this._$Eq && (this._$Eq = this._$Eq.forEach((t3) => this._$ET(t3, this[t3]))), this._$EM();
  }
  updated(t2) {
  }
  firstUpdated(t2) {
  }
}
g2.elementStyles = [], g2.shadowRootOptions = { mode: "open" }, g2[f$1("elementProperties")] = /* @__PURE__ */ new Map(), g2[f$1("finalized")] = /* @__PURE__ */ new Map(), u$1 == null ? void 0 : u$1({ ReactiveElement: g2 }), (l$2.reactiveElementVersions ?? (l$2.reactiveElementVersions = [])).push("2.1.2");
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const s$1 = globalThis;
let i$1 = class i extends g2 {
  constructor() {
    super(...arguments), this.renderOptions = { host: this }, this._$Do = void 0;
  }
  createRenderRoot() {
    var _a3;
    const t2 = super.createRenderRoot();
    return (_a3 = this.renderOptions).renderBefore ?? (_a3.renderBefore = t2.firstChild), t2;
  }
  update(t2) {
    const r2 = this.render();
    this.hasUpdated || (this.renderOptions.isConnected = this.isConnected), super.update(t2), this._$Do = B(r2, this.renderRoot, this.renderOptions);
  }
  connectedCallback() {
    var _a3;
    super.connectedCallback(), (_a3 = this._$Do) == null ? void 0 : _a3.setConnected(true);
  }
  disconnectedCallback() {
    var _a3;
    super.disconnectedCallback(), (_a3 = this._$Do) == null ? void 0 : _a3.setConnected(false);
  }
  render() {
    return E;
  }
};
i$1._$litElement$ = true, i$1["finalized"] = true, (_a2 = s$1.litElementHydrateSupport) == null ? void 0 : _a2.call(s$1, { LitElement: i$1 });
const o$1 = s$1.litElementPolyfillSupport;
o$1 == null ? void 0 : o$1({ LitElement: i$1 });
const n$2 = { _$AK: (t2, e2, r2) => {
  t2._$AK(e2, r2);
}, _$AL: (t2) => t2._$AL };
(s$1.litElementVersions ?? (s$1.litElementVersions = [])).push("4.2.2");
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const e$1 = { attributeToProperty: n$2._$AK, changedProperties: n$2._$AL };
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const t = { CHILD: 2, PROPERTY: 3, BOOLEAN_ATTRIBUTE: 4, EVENT: 5 };
/**
 * @license
 * Copyright 2020 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const n$1 = (o2) => null === o2 || "object" != typeof o2 && "function" != typeof o2, e = { HTML: 1 }, l$1 = (o2, t2) => void 0 !== (o2 == null ? void 0 : o2._$litType$), d = (o2) => {
  var _a3;
  return null != ((_a3 = o2 == null ? void 0 : o2._$litType$) == null ? void 0 : _a3.h);
}, f = (o2) => o2 == null ? void 0 : o2._$litDirective$;
/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
let r = null;
const i2 = { boundAttributeSuffix: Z.M, marker: Z.P, markerMatch: Z.A, getTemplateHtml: Z.L, patchDirectiveResolve: (e2, t2) => {
  if (e2.prototype._$AS.name !== t2.name) {
    r ?? (r = e2.prototype._$AS.name);
    for (let i3 = e2.prototype; i3 !== Object.prototype; i3 = Object.getPrototypeOf(i3)) if (i3.hasOwnProperty(r)) return void (i3[r] = t2);
    throw Error("Internal error: It is possible that both dev mode and production mode Lit was mixed together during SSR. Please comment on the issue: https://github.com/lit/lit/issues/4527");
  }
}, getAttributePartCommittedValue: (e2, r2, i3) => {
  let o2 = E;
  return e2.j = (e3) => o2 = e3, e2._$AI(r2, e2, i3), o2;
}, connectedDisconnectable: (e2) => ({ ...e2, _$AU: true }), resolveDirective: Z.V, AttributePart: Z.H, PropertyPart: Z.B, BooleanAttributePart: Z.N, EventPart: Z.U, isIterable: Z.D };
/**
 * @license
 * Copyright 2020 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const a = Symbol.for(""), o = (t2) => {
  if ((t2 == null ? void 0 : t2.r) === a) return t2 == null ? void 0 : t2._$litStatic$;
}, s = (t2) => ({ _$litStatic$: t2, r: a }), l = /* @__PURE__ */ new Map(), n3 = (t2) => (r2, ...e2) => {
  const a2 = e2.length;
  let s2, i3;
  const n4 = [], u2 = [];
  let c2, $2 = 0, f2 = false;
  for (; $2 < a2; ) {
    for (c2 = r2[$2]; $2 < a2 && void 0 !== (i3 = e2[$2], s2 = o(i3)); ) c2 += s2 + r2[++$2], f2 = true;
    $2 !== a2 && u2.push(i3), n4.push(c2), $2++;
  }
  if ($2 === a2 && n4.push(r2[a2]), f2) {
    const t3 = n4.join("$$lit$$");
    void 0 === (r2 = l.get(t3)) && (n4.raw = n4, l.set(t3, r2 = n4)), e2 = u2;
  }
  return t2(r2, ...e2);
}, u = n3(T);
export {
  A,
  CustomElementRegistryShimWithRealType as C,
  ElementShimWithRealType as E,
  HTMLElementShimWithRealType as H,
  T,
  CustomEventShimWithRealType as a,
  EventShimWithRealType as b,
  EventTargetShimWithRealType as c,
  E as d,
  e,
  f,
  d as g,
  i$1 as h,
  i2 as i,
  ariaMixinAttributes as j,
  HYDRATE_INTERNALS_ATTR_PREFIX as k,
  l$1 as l,
  g2 as m,
  n$1 as n,
  e$1 as o,
  i$2 as p,
  s,
  t,
  u
};
