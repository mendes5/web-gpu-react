import { type NextPage } from "next";
import Head from "next/head";

import { useState, type FC, useRef } from "react";
import { usePresentationFormat, useWebGPUContext } from "~/webgpu/canvas";
import { useGPUDevice } from "~/webgpu/gpu-device";
import { useFrame } from "~/webgpu/per-frame";
import { immediateRenderPass, renderPass } from "~/webgpu/calls";
import { WebGPUApp } from "~/utils/webgpu-app";
import { useToggle } from "usehooks-ts";
import { ToOverlay } from "~/utils/overlay";
import { match } from "ts-pattern";
import { useGPU } from "~/webgpu/use-gpu";

const InterpolationType = {
  /**
   * perspective: Values are interpolated in
   * a perspective correct manner (default)
   */
  perspective: "perspective",
  /**
   * linear: Values are interpolated in a
   * linear, non-perspective correct manner.
   */
  linear: "linear",
  /**
   * flat: Values are not interpolated.
   * Interpolation sampling is not used with
   * flat interpolated
   */
  flat: "flat",
} as const;

const InterpolationSampling = {
  /**
   * Interpolation is performed at the center
   * of the pixel (default)
   */
  center: "center",
  /**
   * Interpolation is performed at a point that
   * lies within all the samples covered by the
   * fragment within the current primitive. This value is the same for all samples in the primitive.
   */
  centroid: "centroid",
  /**
   * Interpolation is performed per sample. The
   * fragment shader is invoked once per sample
   * when this attribute is applied.
   */
  sample: "sample",
} as const;

const Example: FC = () => {
  const [value, toggle] = useToggle();

  const [type, setType] = useState<string>(InterpolationType.perspective);
  const [sampling, setSampling] = useState<string>(
    InterpolationSampling.center
  );

  const formatInterpolation = (type: string, sampling: string) =>
    match(type)
      .with("flat", (type) => type)
      .otherwise(() => `${type}, ${sampling}`);

  const presentationFormat = usePresentationFormat();
  const frameRef = useRef<(frame: number) => void>();

  const device = useGPUDevice();
  const context = useWebGPUContext();

  useGPU(
    { presentationFormat, device },
    (gpu, { presentationFormat, device }) => {
      const shader = gpu.createShaderModule({
        label: "rgb  triangle shader",
        code: value
          ? /* wgsl */ `
            struct OurVertexShaderOutput {
              // Note @builtin(position) is accessible in the 
              // vertex shader too, so you can either access fsInput.position
              // or @builtin(position) directly
              @builtin(position) position: vec4f,
    
              // Note that if the inter-stage variable is an integer type then you must set its interpolation to flat.
              // @location(2) @interpolate(linear, center) myVariableFoo: vec4f;
              @location(0) @interpolate(${formatInterpolation(
                type,
                sampling
              )}) color: vec4f,
            };
            
            // this shader will be invoked 3 times
            // since we called pass.draw(3);
            // with it, each time vsMain is called
            // @builtin(vertex_index)
            // changes with the vertex id 
            @vertex fn vsMain(@builtin(vertex_index) vertexIndex : u32) -> OurVertexShaderOutput {
              var pos = array<vec2f, 3>(
                vec2f( 0.0,  0.5),  // top center
                vec2f(-0.5, -0.5),  // bottom left
                vec2f( 0.5, -0.5)   // bottom right
              );
              var color = array<vec4f, 3>(
                vec4f(1, 0, 0, 1), // red
                vec4f(0, 1, 0, 1), // green
                vec4f(0, 0, 1, 1), // blue
              );
              var vsOutput: OurVertexShaderOutput;
                vsOutput.position = vec4f(pos[vertexIndex], 0.0, 1.0);
                vsOutput.color = color[vertexIndex];
                return vsOutput;
            }
    
            // The @location(0) can mean different things based of 
            // where they are used
            // if it is used between an vertex shader and fragment shader
            // the data in the location will be interpolated
            // if it is used as the output of the fragment shader
            // the computed result will be placed into the view at location(0)
    
            // interpolation settings must be the same
            @fragment fn fsMain(@location(0) @interpolate(${formatInterpolation(
              type,
              sampling
            )}) color: vec4f) -> @location(0) vec4f {
              return color;
            }
    
            // Thats why this shader works too
            // we can either receive the full OurVertexShaderOutput since it is
            // the output of the vertex shader
            // or specific data by referencing locations manually
            // It probably doesn't has any benefits tough since the data is already
            // tightly packed, so this is mostly a convenience
            // @fragment fn fsMain(fsInput: OurVertexShaderOutput) -> @location(0) vec4f {
            //   return fsInput.color;
            // }
          `
          : /* wgsl */ `
            struct OurVertexShaderOutput {
              @builtin(position) position: vec4f,
            };
            
            @vertex fn vsMain(@builtin(vertex_index) vertexIndex : u32) -> OurVertexShaderOutput {
              var pos = array<vec2f, 3>(
                vec2f( 0.0,  1.5),  // top center
                vec2f(-0.5, -0.5),  // bottom left
                vec2f( 0.5, -0.5)   // bottom right
              );
              var vsOutput: OurVertexShaderOutput;
                vsOutput.position = vec4f(pos[vertexIndex], 0.0, 1.0);
                return vsOutput;
            }
    
            @fragment fn fsMain(fsInput: OurVertexShaderOutput) -> @location(0) vec4f {
              let red = vec4f(1, 0, 0, 1);
              let cyan = vec4f(0, 1, 1, 1);
    
              let grid = vec2u(fsInput.position.xy) / 100;
              let checker = (grid.x + grid.y) % 2 == 1;
    
              return select(red, cyan, checker);
            }
      `,
      });

      const pipeline = gpu.createRenderPipeline({
        label: "Main render pipeline",
        layout: "auto",
        vertex: {
          module: shader,
          buffers: [],
          entryPoint: "vsMain",
        },
        fragment: {
          module: shader,
          entryPoint: "fsMain",
          targets: [{ format: presentationFormat }],
        },
      });

      frameRef.current = () => {
        const renderPassDescriptor: GPURenderPassDescriptor = {
          label: "our basic canvas  renderPass",
          colorAttachments: [
            // This is the location(0)
            // since we use context.getCurrentTexture as the view
            // it will render to the canvas
            {
              view: context.getCurrentTexture().createView(),
              clearValue: [0.0, 0.0, 0.0, 1],
              loadOp: "clear",
              storeOp: "store",
            },
          ],
        };

        immediateRenderPass(device, "triangle encoder", (encoder) => {
          renderPass(encoder, renderPassDescriptor, (pass) => {
            pass.setPipeline(pipeline);
            pass.draw(3);
          });
        });
      };
    },
    [value, type, sampling]
  );

  useFrame((time) => {
    frameRef.current?.(time);
  });

  return (
    <ToOverlay>
      <button
        className="rounded bg-slate-900 px-4 py-2 font-bold text-white"
        onClick={toggle}
      >
        Use {value ? "Checkers" : "RGB"}
      </button>
      {value && (
        <>
          <select
            value={type}
            onChange={(event) => setType(event.currentTarget.value)}
            className="rounded bg-slate-900 px-4 py-2 font-bold text-white"
          >
            {Object.entries(InterpolationType).map(([key, value]) => (
              <option key={value} value={value}>
                Interpolation Type: {key}
              </option>
            ))}
          </select>

          {type !== "flat" && (
            <select
              value={sampling}
              onChange={(event) => setSampling(event.currentTarget.value)}
              className="rounded bg-slate-900 px-4 py-2 font-bold text-white"
            >
              {Object.entries(InterpolationSampling).map(([key, value]) => (
                <option key={value} value={value}>
                  Interpolation Sampling: {key}
                </option>
              ))}
            </select>
          )}
        </>
      )}
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
