# html-bundle

> A very simple zero-config bundler for HTML files. The idea is to use HTML as Single File Components, because HTML can already include `<style>` and `<script>` Elements. Additionally, `TypeScript` and `Top-level await` can be used as inline or referenced script in HTML.

## Installation and Usage

```properties
$ npm install -D html-bundle
{ ...
  "build": "html-bundle" // see flags below
}
$ npm run build
```

## CLI

`--live`: sets a watcher on the src directory in order to trigger builds on the fly.<br>
`--critical`: uses [critical](https://www.npmjs.com/package/critical) to extract and inline critical-path CSS to HTML. <em>This will not work with '--live'.</em>

## Concept

The bundler always globs all HTML, CSS and TS/JS files from the src/ directory and minifies them to the build/ directory. CSSO is being used for minifying CSS files and inline styles, html-minifier for HTML and esbuild for inline and referenced TS/JS. Additionally, TS/JS files and inline scripts will be bundled as esm by esbuild. However, packages in inline script elements will be created in 'build/globals' to re-import them with ease. This works for dynamic import too!

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

- Treeshake dynamic imports
- VSCode Plugin for TypeScript Support in HTML
