export type ParsedDOM = Document | Element | DocumentFragment | Text;

export type HTMLPatchMessage = {
  html: string;
  previousHtml?: string;
};

export type DOMRenderer = {
  parse(htmlText: string): ParsedDOM;
  render(
    element: Node,
    where?: Node | string | false,
    shouldSchedule?: boolean,
  ): void;
  withoutReactivity<T>(parse: () => T): T;
};

export type DOMPatcherOptions = {
  regionSelector: string;
  clientSelector: string;
  getLastHTML(): string | undefined;
  setLastHTML(html: string): void;
  bust(url: string): string;
};

export function createDOMPatcher(
  renderer: DOMRenderer,
  options: DOMPatcherOptions,
) {
  return {
    patch(message: HTMLPatchMessage, liveDocument: Document): boolean {
      if (isDocumentHTML(message.html)) {
        patchDocument(message, liveDocument);
        return true;
      }

      patchFragment(message, liveDocument);
      return false;
    },
  };

  function topLevelNodes(parsed: ParsedDOM): Node[] {
    return parsed.nodeType === Node.DOCUMENT_FRAGMENT_NODE ||
      parsed.nodeType === Node.DOCUMENT_NODE
      ? Array.from(parsed.childNodes)
      : [parsed];
  }

  function patchFragment(
    message: HTMLPatchMessage,
    liveDocument: Document,
  ): void {
    const incoming = parseMarkup(message.html);
    const nextNodes = topLevelNodes(incoming);
    const regions = Array.from(
      liveDocument.querySelectorAll(options.regionSelector),
    );

    if (!regions.length) {
      options.setLastHTML(message.html);
      return;
    }

    const previousText = message.previousHtml || options.getLastHTML();
    const previousNodes = previousText
      ? topLevelNodes(parseMarkup(previousText))
      : [];

    regions.forEach((where, index) => {
      if (index < nextNodes.length) {
        const previousNode = previousNodes[index];
        const nextNode = nextNodes[index];
        if (previousNode && sameNodeIdentity(previousNode, nextNode)) {
          patchNode(previousNode, nextNode, where, liveDocument);
        } else {
          renderer.render(cloneForRender(nextNode, liveDocument), where, false);
        }
      } else {
        where.remove();
      }
    });

    for (let rest = regions.length; rest < nextNodes.length; rest++) {
      const template = liveDocument.createElement("template");
      const regionList = Array.from(
        liveDocument.querySelectorAll(options.regionSelector),
      );
      const lastRegion = regionList[regionList.length - 1];
      if (!lastRegion) break;
      lastRegion.after(template);
      renderer.render(
        cloneForRender(nextNodes[rest], liveDocument),
        template,
        false,
      );
      template.remove();
    }

    options.setLastHTML(message.html);
  }

  function patchDocument(
    message: HTMLPatchMessage,
    liveDocument: Document,
  ): void {
    const previousText =
      message.previousHtml ||
      options.getLastHTML() ||
      liveDocument.documentElement.outerHTML;
    const previousDocument = getDocumentParts(parseMarkup(previousText));
    const nextDocument = getDocumentParts(parseMarkup(message.html));

    if (!previousDocument.html || !nextDocument.html) {
      renderer.render(
        parseMarkup(message.html) as Node,
        liveDocument.documentElement,
        false,
      );
      options.setLastHTML(message.html);
      return;
    }

    patchAttributes(liveDocument.documentElement, nextDocument.html);
    if (previousDocument.head && nextDocument.head && liveDocument.head) {
      patchChildren(
        previousDocument.head,
        nextDocument.head,
        liveDocument.head,
        liveDocument,
      );
      patchAttributes(liveDocument.head, nextDocument.head);
    }
    if (previousDocument.body && nextDocument.body && liveDocument.body) {
      patchChildren(
        previousDocument.body,
        nextDocument.body,
        liveDocument.body,
        liveDocument,
      );
      patchAttributes(liveDocument.body, nextDocument.body);
    }

    options.setLastHTML(message.html);
  }

  function getDocumentParts(parsed: ParsedDOM): {
    html: Element;
    head: Element | null;
    body: Element | null;
  } {
    const htmlNode = (
      parsed instanceof HTMLHtmlElement
        ? parsed
        : (parsed as Element).querySelector?.("html") || parsed
    ) as Element;
    return {
      html: htmlNode,
      head: htmlNode.querySelector?.("head") || null,
      body: htmlNode.querySelector?.("body") || null,
    };
  }

  function parseMarkup(htmlText: string): ParsedDOM {
    try {
      return renderer.parse(htmlText);
    } catch {
      return renderer.withoutReactivity(() => renderer.parse(htmlText));
    }
  }

  function patchChildren(
    previousParent: Node,
    nextParent: Node,
    liveParent: Node,
    liveDocument: Document,
  ): void {
    const previousNodes = comparableNodes(previousParent);
    const nextNodes = comparableNodes(nextParent);
    let previousIndex = 0;
    let nextIndex = 0;
    let liveIndex = 0;

    while (nextIndex < nextNodes.length) {
      const previousNode = previousNodes[previousIndex];
      const nextNode = nextNodes[nextIndex];
      const liveNode = nextLiveNode(liveParent, liveIndex);

      if (!liveNode) {
        (liveParent as Element).append(cloneForRender(nextNode, liveDocument));
        nextIndex++;
        liveIndex++;
        continue;
      }

      if (!previousNode) {
        renderer.render(
          cloneForRender(nextNode, liveDocument),
          liveNode,
          false,
        );
        nextIndex++;
        liveIndex++;
        continue;
      }

      const previousMatch = findStaticMatch(
        previousNodes,
        nextNode,
        previousIndex + 1,
      );
      const nextMatch = findStaticMatch(nextNodes, previousNode, nextIndex + 1);

      if (previousMatch !== -1 && nextMatch === -1) {
        liveNode.remove();
        previousIndex++;
        continue;
      }

      if (nextMatch !== -1) {
        liveNode.before(cloneForRender(nextNode, liveDocument));
        nextIndex++;
        liveIndex++;
        continue;
      }

      if (sameNodeIdentity(previousNode, nextNode)) {
        patchNode(previousNode, nextNode, liveNode, liveDocument);
        previousIndex++;
        nextIndex++;
        liveIndex++;
        continue;
      }

      renderer.render(cloneForRender(nextNode, liveDocument), liveNode, false);
      previousIndex++;
      nextIndex++;
      liveIndex++;
    }

    while (
      previousIndex < previousNodes.length &&
      nextLiveNode(liveParent, liveIndex)
    ) {
      nextLiveNode(liveParent, liveIndex)!.remove();
      previousIndex++;
    }
  }

  function patchNode(
    previousNode: Node,
    nextNode: Node,
    liveNode: Node,
    liveDocument: Document,
  ): void {
    if (sameStaticNode(previousNode, nextNode)) return;
    if (
      previousNode.nodeType !== nextNode.nodeType ||
      liveNode.nodeType !== nextNode.nodeType
    ) {
      renderer.render(cloneForRender(nextNode, liveDocument), liveNode, false);
      return;
    }
    if (nextNode.nodeType === Node.TEXT_NODE) {
      liveNode.nodeValue = nextNode.nodeValue;
      return;
    }
    if (nextNode.nodeType !== Node.ELEMENT_NODE) {
      renderer.render(cloneForRender(nextNode, liveDocument), liveNode, false);
      return;
    }
    if ((nextNode as Element).localName === "script") {
      patchScript(previousNode, nextNode as Element, liveNode, liveDocument);
      return;
    }
    patchAttributes(liveNode as Element, nextNode as Element);
    patchChildren(previousNode, nextNode, liveNode, liveDocument);
  }

  function patchScript(
    previousScript: Node,
    nextScript: Element,
    liveScript: Node,
    liveDocument: Document,
  ): void {
    if (previousScript.isEqualNode(nextScript)) return;
    const clone = cloneScript(nextScript, liveDocument);
    const source = clone.getAttribute("src");
    if (source) clone.setAttribute("src", options.bust(source));
    renderer.render(clone, liveScript, false);
  }

  function cloneForRender(node: Node, liveDocument: Document): Node {
    if (
      node.nodeType === Node.ELEMENT_NODE &&
      (node as Element).localName === "script"
    ) {
      return cloneScript(node as Element, liveDocument);
    }
    return node.cloneNode(true);
  }

  function cloneScript(
    script: Element,
    liveDocument: Document,
  ): HTMLScriptElement {
    const clone = liveDocument.createElement("script");
    for (const attr of Array.from(script.attributes)) {
      clone.setAttribute(attr.name, attr.value);
    }
    clone.textContent = script.textContent;
    return clone;
  }

  function patchAttributes(liveElement: Element, nextElement: Element): void {
    for (const attr of Array.from(liveElement.attributes)) {
      if (!nextElement.hasAttribute(attr.name)) {
        liveElement.removeAttribute(attr.name);
      }
    }
    for (const attr of Array.from(nextElement.attributes)) {
      if (liveElement.getAttribute(attr.name) !== attr.value) {
        liveElement.setAttribute(attr.name, attr.value);
      }
    }
  }

  function sameStaticNode(previousNode: Node, nextNode: Node): boolean {
    return cloneComparable(previousNode).isEqualNode(cloneComparable(nextNode));
  }

  function sameNodeIdentity(previousNode: Node, nextNode: Node): boolean {
    return (
      previousNode.nodeType === nextNode.nodeType &&
      previousNode.nodeName === nextNode.nodeName
    );
  }

  function findStaticMatch(nodes: Node[], needle: Node, start: number): number {
    for (let index = start; index < nodes.length; index++) {
      if (sameStaticNode(nodes[index], needle)) return index;
    }
    return -1;
  }

  function cloneComparable(node: Node): Node {
    const clone = node.cloneNode(true) as Element;
    clone
      .querySelectorAll?.(options.clientSelector)
      .forEach((script) => script.remove());
    if (clone.matches?.(options.clientSelector)) clone.remove();
    return clone;
  }

  function comparableNodes(parent: Node): ChildNode[] {
    return Array.from(parent.childNodes).filter(
      (node) =>
        !(
          node.nodeType === Node.ELEMENT_NODE &&
          (node as Element).matches?.(options.clientSelector)
        ),
    );
  }

  function nextLiveNode(parent: Node, index: number): ChildNode | undefined {
    return comparableNodes(parent)[index];
  }
}

export function createNativeDOMRenderer(): DOMRenderer {
  return {
    parse(htmlText) {
      if (isDocumentHTML(htmlText)) {
        return new DOMParser().parseFromString(htmlText, "text/html")
          .documentElement;
      }

      const template = document.createElement("template");
      template.innerHTML = htmlText;
      return template.content;
    },
    render(element, where) {
      if (!where || typeof where === "string") return;
      where.parentNode?.replaceChild(element, where);
    },
    withoutReactivity(parse) {
      return parse();
    },
  };
}

function isDocumentHTML(htmlText: string): boolean {
  const trimmed = htmlText.trimStart().toLowerCase();
  return trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html");
}
