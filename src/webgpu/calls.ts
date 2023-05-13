export function getPresentationFormat() {
  return navigator.gpu.getPreferredCanvasFormat();
}

export function configureContextPresentation(
  device: GPUDevice,
  context: GPUCanvasContext
) {
  const presentationFormat = getPresentationFormat();

  context.configure({
    device,
    format: presentationFormat,
  });
}

export async function requestAdapter() {
  const adapter = await navigator.gpu.requestAdapter();

  if (!adapter) {
    throw new Error("Failed to request adatper");
  }

  const device = await adapter.requestDevice();

  if (!device) {
    throw new Error("Failed to request devide");
  }

  return device;
}

export function createShaderModule(
  device: GPUDevice,
  code: string,
  label?: string
) {
  const shader = device.createShaderModule({
    label,
    code,
  });

  return shader;
}
