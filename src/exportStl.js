import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';

const exporter = new STLExporter();

export function downloadStl(mesh, filename) {
  const result = exporter.parse(mesh, { binary: true });
  const blob = new Blob([result], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
