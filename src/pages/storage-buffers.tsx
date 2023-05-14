import { type NextPage } from "next";
import Head from "next/head";

import { api } from "~/utils/api";

import { useMemo, type FC, useRef } from "react";
import { useWebGPUCanvas, useWebGPUContext } from "~/webgpu/canvas";
import { useGPUDevice } from "~/webgpu/gpu-device";
import { useFrame } from "~/webgpu/per-frame";
import { usePipeline, useShaderModule } from "~/webgpu/shader";
import { immediateRenderPass, renderPass } from "~/webgpu/calls";
import { WebGPUApp } from "~/helpers/webgpu-app";
import { ToOverlay } from "~/helpers/overlay";
import { rand, range } from "~/utils/other";
import { useConsoleHook } from "~/webgpu/console-hook";
import { createCircleVertices } from "~/helpers/geometry";

/**
 * Differences betwen uniform buffers and storage buffers
 * - Uniform buffers can be faster for their typical use-case
 * - Storage buffers are large and W I D E
 *   - The minimum maximum size of a uniform buffer is 64k
 *   - The minimum maximum size of a storage buffer is 128meg!
 * - Storage buffers can be read/write, Uniform buffers are read-only
 */

/**
 *
 */
const Example: FC = () => {
  const shader = useShaderModule(
    /* wgsl */ `
        struct OurStruct {
          color: vec4f,
          offset: vec2f,
        };

        struct OtherStruct {
          scale: vec2f,
        };

        struct Vertex {
          position: vec2f,
        };

        struct VSOutput {
          @builtin(position) position: vec4f,
          @location(0) color: vec4f,
        }

        @group(0) @binding(0) var<storage, read> ourStructs: array<OurStruct>;
        @group(0) @binding(1) var<storage, read> otherStructs: array<OtherStruct>;
        @group(0) @binding(2) var<storage, read> pos: array<Vertex>;

        @vertex fn vsMain(
          @builtin(vertex_index) vertexIndex: u32,
          @builtin(instance_index) instanceIndex: u32
        ) ->  VSOutput  {
          let otherStruct = otherStructs[instanceIndex];
          let ourStruct = ourStructs[instanceIndex];

          var vsOut: VSOutput;
          vsOut.position = vec4f(
            pos[vertexIndex].position * otherStruct.scale + ourStruct.offset, 0.0, 1.0);
          vsOut.color = ourStruct.color;

          return vsOut;
        }
      
        @fragment fn fsMain(vsOut: VSOutput) -> @location(0) vec4f {
          return vsOut.color;
        }
      `,
    "rgb  triangle shader"
  );

  /**
   * Pipeline will be recreated if the shader changes
   */
  const pipeline = usePipeline(shader, "Main render pipeline");

  const device = useGPUDevice();
  const context = useWebGPUContext();

  const kScaleOffset = 0;

  const kNumObjects = 100;
  const staticUnitSize =
    4 * 4 + // color is 4 32bit floats (4bytes each)
    2 * 4 + // offset is 2 32bit floats (4bytes each)
    2 * 4; // padding
  const changingUnitSize = 2 * 4; // scale is 2 32bit floats (4bytes each)
  const staticStorageBufferSize = staticUnitSize * kNumObjects;
  const changingStorageBufferSize = changingUnitSize * kNumObjects;

  // offsets to the various uniform values in float32 indices
  const kColorOffset = 0;
  const kOffsetOffset = 4;

  const {
    objectInfos,
    storageValues,
    changingStorageBuffer,
    bindGroup,
    staticStorageValues,
    numVertices,
    staticStorageBuffer,
  } = useMemo(() => {
    const objectInfos = [];

    // create 2 storage buffers
    const staticStorageBuffer = device.createBuffer({
      label: "static storage for objects",
      size: staticStorageBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const changingStorageBuffer = device.createBuffer({
      label: "changing storage for objects",
      size: changingStorageBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const staticStorageValues = new Float32Array(staticStorageBufferSize / 4);

    for (let i = 0; i < kNumObjects; ++i) {
      const staticOffset = i * (staticUnitSize / 4);

      // These are only set once so set them now
      staticStorageValues.set(
        [rand(), rand(), rand(), 1],
        staticOffset + kColorOffset
      ); // set the color
      staticStorageValues.set(
        [rand(-0.9, 0.9), rand(-0.9, 0.9)],
        staticOffset + kOffsetOffset
      ); // set the offset

      objectInfos.push({
        scale: rand(0.2, 0.5),
      });
    }
    device.queue.writeBuffer(staticStorageBuffer, 0, staticStorageValues);

    const storageValues = new Float32Array(changingStorageBufferSize / 4);

    // Vertex buffer setup

    const { vertexData, numVertices } = createCircleVertices({
      radius: 0.5,
      innerRadius: 0.25,
    });

    const vertexStorageBuffer = device.createBuffer({
      label: "storage buffer vertices",
      size: vertexData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    device.queue.writeBuffer(vertexStorageBuffer, 0, vertexData);

    const bindGroup = device.createBindGroup({
      label: "bind group for objects",
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: staticStorageBuffer } },
        { binding: 1, resource: { buffer: changingStorageBuffer } },
        { binding: 2, resource: { buffer: vertexStorageBuffer } },
      ],
    });

    return {
      numVertices,
      staticStorageValues,
      objectInfos,
      storageValues,
      changingStorageBuffer,
      staticStorageBuffer,
      bindGroup,
    };
  }, [
    device,
    pipeline,
    changingStorageBufferSize,
    staticStorageBufferSize,
    staticUnitSize,
  ]);

  const randomize = useConsoleHook("randomize", () => {
    for (const i of range(kNumObjects)) {
      const staticOffset = i * (staticUnitSize / 4);

      staticStorageValues.set(
        [rand(), rand(), rand(), 1],
        staticOffset + kColorOffset
      );
      staticStorageValues.set(
        [rand(-0.9, 0.9), rand(-0.9, 0.9)],
        staticOffset + kOffsetOffset
      );
      device.queue.writeBuffer(staticStorageBuffer, 0, staticStorageValues);
    }
  });

  /**
   * It's so much more easy that way...
   *
   * If I randomly need access to the canvas I just
   * call useWebGPUCanvas and get a reference to it
   *
   * No need for a base Object3D class or magic Managers
   * just get what you need and use it
   */
  const canvas = useWebGPUCanvas();

  const objectCountRef = useRef(kNumObjects);

  useFrame(() => {
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
        pass.setPipeline(pipeline);

        const aspect = canvas.width / canvas.height;

        // set the scales for each object
        objectInfos.forEach(({ scale }, ndx) => {
          const offset = ndx * (changingUnitSize / 4);
          storageValues.set([scale / aspect, scale], offset + kScaleOffset); // set the scale
        });
        // upload all scales at once
        device.queue.writeBuffer(changingStorageBuffer, 0, storageValues);

        pass.setBindGroup(0, bindGroup);
        pass.draw(numVertices, objectCountRef.current); // call our vertex shader 3 times for each instance
      });
    });
  });

  const spanRef = useRef<HTMLSpanElement>(null);

  return (
    <ToOverlay>
      <button
        className="rounded bg-slate-900 px-4 py-2 font-bold text-white"
        onClick={randomize}
      >
        Randomize
      </button>
      <label className="font-bold text-white">
        Number of instances:{" "}
        <input
          type="range"
          min={0}
          defaultValue={kNumObjects}
          max={kNumObjects}
          onInput={(event) => {
            objectCountRef.current = parseInt(event.currentTarget.value, 10);

            if (spanRef.current) {
              spanRef.current.innerText = String(objectCountRef.current);
            }
          }}
        />
        <span ref={spanRef}>{kNumObjects}</span>
      </label>
    </ToOverlay>
  );
};

const Home: NextPage = () => {
  const version = api.meta.version.useQuery();

  return (
    <>
      <Head>
        <title>WebGPU Tests</title>
        <link rel="icon" href="/favicon.svg" />
        <meta rel="app-version" content={version.data} />
      </Head>
      <WebGPUApp fullscreen>
        <Example />
      </WebGPUApp>
    </>
  );
};

export default Home;
