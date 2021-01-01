# html-bundle

> A very simple zero-config bundler for HTML files. The idea is to use HTML as Single File Components, because HTML can already include `<style>` and `<script>` Elements. Additionally, `TypeScript` can be used as inline or referenced script in HTML.

## Disclaimer

- This package relies heavily on `RegEx`. It is probably not production ready and I might have missed an import case.

## Installation and Usage

```properties
$ npm install -D html-bundle
{ ...
  "build": "html-bundle" // '--live' to keep the process alive
}
$ npm run build
```

## Concept

The bundler always globs all HTML, CSS and TS/JS files from the src/ directory and minifies them to the build/ directory. CSSO is being used for minifying CSS files and inline styles, html-minifier for HTML and esbuild for TS/JS. Additionally, TS/JS files and inline scripts will be bundled as esm by esbuild.

## Example

### Input

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Example</title>
    <meta name="Description" content="Example for html-bundle" />
    <script type="module">
      import { render, html } from "hydro-js";
      render(html`<main id="app">Testing html-bundle</main>`, "#app");
    </script>
    <style>
      body {
        background-color: whitesmoke;
      }
    </style>
  </head>
  <body>
    <main id="app"></main>
  </body>
</html>
```

### Output

![Output](output.JPG)

## Roadmap

- VSCode Plugin for highlighting TypeScript in HTML
