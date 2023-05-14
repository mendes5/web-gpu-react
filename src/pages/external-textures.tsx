import { type NextPage } from "next";
import Head from "next/head";

import { useMemo, type FC, useState, useId, useRef } from "react";
import { useWebGPUCanvas, useWebGPUContext } from "~/webgpu/canvas";
import { useGPUDevice } from "~/webgpu/gpu-device";
import { useFrame } from "~/webgpu/per-frame";
import { usePipeline, useShaderModule } from "~/webgpu/shader";
import { immediateRenderPass, renderPass } from "~/webgpu/calls";
import { WebGPUApp } from "~/helpers/webgpu-app";
import { ToOverlay } from "~/helpers/overlay";
import { useAsyncResource, useHashedCache } from "~/utils/hooks";
import Link from "next/link";

async function loadImageBitmap(url: string) {
  const res = await fetch(url);
  const blob = await res.blob();
  return await createImageBitmap(blob, { colorSpaceConversion: "none" });
}

const AddressMode = {
  clampToEdge: "clamp-to-edge",
  repeat: "repeat",
  mirrorRepeat: "mirror-repeat",
} as const;

const FilterMode = {
  nearest: "nearest",
  linear: "linear",
} as const;

const Example: FC = () => {
  const shader = useShaderModule(
    /* wgsl */ `
      struct OurVertexShaderOutput {
        @builtin(position) position: vec4f,
        @location(0) texcoord: vec2f,
      };

      struct Uniforms {
        scale: vec2f,
        offset: vec2f,
      };
       
      @group(0) @binding(2) var<uniform> uni: Uniforms;
      
      @vertex fn vsMain(@builtin(vertex_index) vertexIndex: u32) -> OurVertexShaderOutput {
        var pos = array<vec2f, 6>(
          // 1st triangle
          vec2f( 0.0,  0.0),  // center
          vec2f( 1.0,  0.0),  // right, center
          vec2f( 0.0,  1.0),  // center, top
        
          // 2st triangle
          vec2f( 0.0,  1.0),  // center, top
          vec2f( 1.0,  0.0),  // right, center
          vec2f( 1.0,  1.0),  // right, top
        );

        var vsOutput: OurVertexShaderOutput;
        let xy = pos[vertexIndex];
        vsOutput.position = vec4f(xy * uni.scale + uni.offset, 0.0, 1.0);
        vsOutput.texcoord = xy;
        return vsOutput;
      }

      @group(0) @binding(0) var ourSampler: sampler;
      @group(0) @binding(1) var ourTexture: texture_2d<f32>;

      @fragment fn fsMain(fsInput: OurVertexShaderOutput) -> @location(0) vec4f {
        return textureSample(ourTexture, ourSampler, fsInput.texcoord);
      }`,
    "rgb  triangle shader"
  );

  const pipeline = usePipeline(shader, "Main render pipeline");

  const device = useGPUDevice();
  const context = useWebGPUContext();

  const [modeU, setModeU] = useState<string>(AddressMode.repeat);
  const [modeV, setModeV] = useState<string>(AddressMode.repeat);
  const [magFilter, setMagFilter] = useState<string>(FilterMode.nearest);
  const [minFilter, setMingFilter] = useState<string>(FilterMode.nearest);

  const textureState = useAsyncResource(async () => {
    const url = "/resources/f-texture.png";
    const source = await loadImageBitmap(url);

    const texture = device.createTexture({
      label: url,
      format: "rgba8unorm",
      size: [source.width, source.height],
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        // for some reason RENDER_ATTACHMENT
        // not sure why since we are not rendering shit
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    device.queue.copyExternalImageToTexture(
      { source, flipY: true },
      { texture },
      { width: source.width, height: source.height }
    );

    return { texture };
  }, [device]);

  const { uniformBuffer, uniformValues, kScaleOffset, kOffsetOffset } =
    useMemo(() => {
      const uniformBufferSize =
        2 * 4 + // scale is 2 32bit floats (4bytes each)
        2 * 4; // offset is 2 32bit floats (4bytes each)
      const uniformBuffer = device.createBuffer({
        label: "uniforms for quad",
        size: uniformBufferSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      // create a typedarray to hold the values for the uniforms in JavaScript
      const uniformValues = new Float32Array(uniformBufferSize / 4);

      // offsets to the various uniform values in float32 indices
      const kScaleOffset = 0;
      const kOffsetOffset = 2;

      return { uniformBuffer, uniformValues, kScaleOffset, kOffsetOffset };
    }, [device]);

  const { sampler } = useHashedCache(
    useId(),
    () => {
      const sampler = device.createSampler({
        addressModeU: modeU as GPUAddressMode,
        addressModeV: modeV as GPUAddressMode,
        magFilter: magFilter as GPUFilterMode,
        minFilter: minFilter as GPUFilterMode,
      });

      return { sampler };
    },
    [device],
    [modeU, modeV, magFilter, minFilter]
  );

  const { bindGroup } = useMemo(() => {
    if (textureState.type === "success") {
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: sampler },
          { binding: 1, resource: textureState.value.texture.createView() },
          { binding: 2, resource: { buffer: uniformBuffer } },
        ],
      });

      return { bindGroup };
    } else {
      return { bindGroup: null };
    }
  }, [sampler, device, pipeline, uniformBuffer, textureState]);

  const canvas = useWebGPUCanvas();

  useFrame((time) => {
    time *= 0.001;

    const renderPassDescriptor: GPURenderPassDescriptor = {
      label: "our basic canvas renderPass",
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: [0.3, 0.3, 0.3, 1],
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    };

    immediateRenderPass(device, "triangle encoder", (encoder) => {
      renderPass(encoder, renderPassDescriptor, (pass) => {
        if (bindGroup) {
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindGroup);

          // compute a scale that will draw our 0 to 1 clip space quad
          // 2x2 pixels in the canvas.
          const scaleX = (4 / canvas.width) * 100;
          const scaleY = (4 / canvas.height) * 100;

          uniformValues.set([scaleX, scaleY], kScaleOffset); // set the scale
          uniformValues.set([Math.sin(time * 0.25) * 0.8, -0.8], kOffsetOffset); // set the offset

          // copy the values from JavaScript to the GPU
          device.queue.writeBuffer(uniformBuffer, 0, uniformValues);

          pass.draw(6);
        }
      });
    });
  });

  return (
    <ToOverlay>
      <select
        onChange={(event) => setMingFilter(event.currentTarget.value)}
        className="rounded bg-slate-900 px-4 py-2 font-bold text-white"
      >
        {Object.entries(FilterMode).map(([key, value]) => (
          <option key={value} value={value}>
            Min Filter Mode: {key}
          </option>
        ))}
      </select>

      <select
        onChange={(event) => setMagFilter(event.currentTarget.value)}
        className="rounded bg-slate-900 px-4 py-2 font-bold text-white"
      >
        {Object.entries(FilterMode).map(([key, value]) => (
          <option key={value} value={value}>
            Mag Filter Mode: {key}
          </option>
        ))}
      </select>

      {magFilter !== "nearest" && (
        <>
          <select
            onChange={(event) => setModeU(event.currentTarget.value)}
            className="rounded bg-slate-900 px-4 py-2 font-bold text-white"
          >
            {Object.entries(AddressMode).map(([key, value]) => (
              <option key={value} value={value}>
                Address Mode U: {key}
              </option>
            ))}
          </select>
          <select
            onChange={(event) => setModeV(event.currentTarget.value)}
            className="rounded bg-slate-900 px-4 py-2 font-bold text-white"
          >
            {Object.entries(AddressMode).map(([key, value]) => (
              <option key={value} value={value}>
                Address Mode V: {key}
              </option>
            ))}
          </select>
        </>
      )}
      <ul>
        <li>
          <Link href="/index-buffers">With GPU Mips</Link>
        </li>
      </ul>
    </ToOverlay>
  );
};

const Home: NextPage = () => {
  return (
    <>
      <Head>
        <title>WebGPU Tests</title>
        <link rel="icon" href="/favicon.svg" />
      </Head>

      <WebGPUApp fullscreen>
        <Example />
      </WebGPUApp>
    </>
  );
};

export default Home;
