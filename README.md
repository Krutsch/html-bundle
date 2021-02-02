# html-bundle

> A very simple zero-config bundler for HTML files. The idea is to use HTML as Single File Components, because HTML can already include `<style>` and `<script>` elements. Additionally, `TypeScript` can be used as inline or referenced script in HTML.

## Installation and Usage

```properties
$ npm install -D html-bundle
```

Add an entry to script in package.json (see flags below).

```json
{
  "scripts": {
    "build": "html-bundle"
  }
}
```

Add a `postcss.config.cjs` file and run the build command.
<em>If you do not create this config file, a minimal in-memory config file will be created with `cssnano` as plugin.</em>

```properties
$ npm run build
```

## CLI

`--hmr`: boots up a static server and enables Hot Module Replacement. This works at its best with non-root HTML files without file references.<br>
`--secure`: starts the hmr server as a secure HTTP2 over HTTPS instance. This requires the files `localhost.pem` and `localhost-key.pem` in the root folder. You can generate them with [mkcert](https://github.com/FiloSottile/mkcert) for instance.
`--critical`: uses [critical](https://www.npmjs.com/package/critical) to extract and inline critical-path CSS to HTML.

## Concept

The bundler always globs all HTML, CSS and TS/JS files from the `src/` directory and processes them to the `build/` directory. PostCSS is being used for CSS files and inline styles, html-minifier for HTML and esbuild to bundle, minify, etc. for inline and referenced TS/JS. There are no <strong>regexes</strong>, just <strong>AST</strong> transformations. Server-sent events and [hydro-js](https://github.com/Krutsch/hydro-js) are used for HMR.

## Example hydro-js

Have a look at [hydro-starter](https://github.com/Krutsch/hydro-starter).

#### Input

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

## Example Vue.js

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vue Example</title>
  </head>
  <script type="module">
    import { createApp, h } from "vue";
    import htm from "htm";
    const html = htm.bind(h);

    const App = {
      data() {
        return {
          name: "Fabian",
        };
      },
      render() {
        return html`<p>${this.name}</p>`;
      },
    };

    createApp(App).mount("#app");
  </script>
  <body>
    <div id="app"></div>
  </body>
</html>
```
