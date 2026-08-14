export function createDOMPatcher(renderer, options) {
    return {
        patch(message, liveDocument) {
            if (isDocumentHTML(message.html)) {
                patchDocument(message, liveDocument);
                return true;
            }
            patchFragment(message, liveDocument);
            return false;
        },
    };
    function topLevelNodes(parsed) {
        return parsed.nodeType === Node.DOCUMENT_FRAGMENT_NODE ||
            parsed.nodeType === Node.DOCUMENT_NODE
            ? Array.from(parsed.childNodes)
            : [parsed];
    }
    function patchFragment(message, liveDocument) {
        const incoming = parseMarkup(message.html);
        const nextNodes = topLevelNodes(incoming);
        const regions = Array.from(liveDocument.querySelectorAll(options.regionSelector));
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
                }
                else {
                    renderer.render(cloneForRender(nextNode, liveDocument), where, false);
                }
            }
            else {
                where.remove();
            }
        });
        for (let rest = regions.length; rest < nextNodes.length; rest++) {
            const template = liveDocument.createElement("template");
            const regionList = Array.from(liveDocument.querySelectorAll(options.regionSelector));
            const lastRegion = regionList[regionList.length - 1];
            if (!lastRegion)
                break;
            lastRegion.after(template);
            renderer.render(cloneForRender(nextNodes[rest], liveDocument), template, false);
            template.remove();
        }
        options.setLastHTML(message.html);
    }
    function patchDocument(message, liveDocument) {
        const previousText = message.previousHtml ||
            options.getLastHTML() ||
            liveDocument.documentElement.outerHTML;
        const previousDocument = getDocumentParts(parseMarkup(previousText));
        const nextDocument = getDocumentParts(parseMarkup(message.html));
        if (!previousDocument.html || !nextDocument.html) {
            renderer.render(parseMarkup(message.html), liveDocument.documentElement, false);
            options.setLastHTML(message.html);
            return;
        }
        patchAttributes(liveDocument.documentElement, nextDocument.html);
        if (previousDocument.head && nextDocument.head && liveDocument.head) {
            patchChildren(previousDocument.head, nextDocument.head, liveDocument.head, liveDocument);
            patchAttributes(liveDocument.head, nextDocument.head);
        }
        if (previousDocument.body && nextDocument.body && liveDocument.body) {
            patchChildren(previousDocument.body, nextDocument.body, liveDocument.body, liveDocument);
            patchAttributes(liveDocument.body, nextDocument.body);
        }
        options.setLastHTML(message.html);
    }
    function getDocumentParts(parsed) {
        const htmlNode = (parsed instanceof HTMLHtmlElement
            ? parsed
            : parsed.querySelector?.("html") || parsed);
        return {
            html: htmlNode,
            head: htmlNode.querySelector?.("head") || null,
            body: htmlNode.querySelector?.("body") || null,
        };
    }
    function parseMarkup(htmlText) {
        try {
            return renderer.parse(htmlText);
        }
        catch {
            return renderer.withoutReactivity(() => renderer.parse(htmlText));
        }
    }
    function patchChildren(previousParent, nextParent, liveParent, liveDocument) {
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
                liveParent.append(cloneForRender(nextNode, liveDocument));
                nextIndex++;
                liveIndex++;
                continue;
            }
            if (!previousNode) {
                renderer.render(cloneForRender(nextNode, liveDocument), liveNode, false);
                nextIndex++;
                liveIndex++;
                continue;
            }
            const previousMatch = findStaticMatch(previousNodes, nextNode, previousIndex + 1);
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
        while (previousIndex < previousNodes.length &&
            nextLiveNode(liveParent, liveIndex)) {
            nextLiveNode(liveParent, liveIndex).remove();
            previousIndex++;
        }
    }
    function patchNode(previousNode, nextNode, liveNode, liveDocument) {
        if (sameStaticNode(previousNode, nextNode))
            return;
        if (previousNode.nodeType !== nextNode.nodeType ||
            liveNode.nodeType !== nextNode.nodeType) {
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
        if (nextNode.localName === "script") {
            patchScript(previousNode, nextNode, liveNode, liveDocument);
            return;
        }
        patchAttributes(liveNode, nextNode);
        patchChildren(previousNode, nextNode, liveNode, liveDocument);
    }
    function patchScript(previousScript, nextScript, liveScript, liveDocument) {
        if (previousScript.isEqualNode(nextScript))
            return;
        const clone = cloneScript(nextScript, liveDocument);
        const source = clone.getAttribute("src");
        if (source)
            clone.setAttribute("src", options.bust(source));
        renderer.render(clone, liveScript, false);
    }
    function cloneForRender(node, liveDocument) {
        if (node.nodeType === Node.ELEMENT_NODE &&
            node.localName === "script") {
            return cloneScript(node, liveDocument);
        }
        return node.cloneNode(true);
    }
    function cloneScript(script, liveDocument) {
        const clone = liveDocument.createElement("script");
        for (const attr of Array.from(script.attributes)) {
            clone.setAttribute(attr.name, attr.value);
        }
        clone.textContent = script.textContent;
        return clone;
    }
    function patchAttributes(liveElement, nextElement) {
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
    function sameStaticNode(previousNode, nextNode) {
        return cloneComparable(previousNode).isEqualNode(cloneComparable(nextNode));
    }
    function sameNodeIdentity(previousNode, nextNode) {
        return (previousNode.nodeType === nextNode.nodeType &&
            previousNode.nodeName === nextNode.nodeName);
    }
    function findStaticMatch(nodes, needle, start) {
        for (let index = start; index < nodes.length; index++) {
            if (sameStaticNode(nodes[index], needle))
                return index;
        }
        return -1;
    }
    function cloneComparable(node) {
        const clone = node.cloneNode(true);
        clone
            .querySelectorAll?.(options.clientSelector)
            .forEach((script) => script.remove());
        if (clone.matches?.(options.clientSelector))
            clone.remove();
        return clone;
    }
    function comparableNodes(parent) {
        return Array.from(parent.childNodes).filter((node) => !(node.nodeType === Node.ELEMENT_NODE &&
            node.matches?.(options.clientSelector)));
    }
    function nextLiveNode(parent, index) {
        return comparableNodes(parent)[index];
    }
}
export function createNativeDOMRenderer() {
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
            if (!where || typeof where === "string")
                return;
            where.parentNode?.replaceChild(element, where);
        },
        withoutReactivity(parse) {
            return parse();
        },
    };
}
function isDocumentHTML(htmlText) {
    const trimmed = htmlText.trimStart().toLowerCase();
    return trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html");
}
