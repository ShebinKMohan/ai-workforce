/** Preserve deliberate disclosure choices across transcript rebuilds and tabs. */
export function createChatDisclosures() {
  const scopes = new Map();
  const nodes = root => root.querySelectorAll('details[data-disclosure]');

  return {
    /** Capture the outgoing viewport before replacing its DOM. Hidden nested
     * details still have an independent `open` value and must be remembered. */
    remember(scope, root) {
      let choices = scopes.get(scope);
      if (!choices) { choices = new Map(); scopes.set(scope, choices); }
      for (const node of nodes(root)) {
        const key = node.dataset.disclosure;
        if (key) choices.set(key, node.open === true);
      }
    },

    /** Restore the incoming viewport. Unseen disclosures retain their markup
     * default; missing rows do not erase choices for a later reappearance. */
    restore(scope, root) {
      const choices = scopes.get(scope);
      if (!choices) return;
      for (const node of nodes(root)) {
        const key = node.dataset.disclosure;
        if (choices.has(key)) node.open = choices.get(key);
      }
    },
  };
}
