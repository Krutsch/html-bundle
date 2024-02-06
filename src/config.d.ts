export type Config = {
  build: string;
  src: string;
  port: number;
  secure: boolean;
  esbuild?: BuildOptions;
  "html-minifier-terser"?: HTMLOptions;
  critical?: Options;
  deletePrev?: boolean;
  isCritical?: boolean;
  hmr?: boolean;
  handler?: string;
};
