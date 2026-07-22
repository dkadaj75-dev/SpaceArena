// happy-dom implements HTMLOptionElement but not the legacy `new Option(...)`
// global constructor that SchemaFormGen (and browsers) use to build <option>
// elements. Shim it so tests run against the same code path as the browser.
if (typeof globalThis.Option === "undefined") {
  function OptionPolyfill(text?: string, value?: string, defaultSelected?: boolean, selected?: boolean): HTMLOptionElement {
    const option = document.createElement("option");
    if (text !== undefined) option.text = text;
    if (value !== undefined) option.value = value;
    if (defaultSelected) option.defaultSelected = true;
    if (selected) option.selected = true;
    return option;
  }
  // @ts-expect-error assigning a legacy DOM constructor shim
  globalThis.Option = OptionPolyfill;
}
