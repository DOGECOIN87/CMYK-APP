// shaders.js

export const vertexShaderSource = `
    attribute vec2 a_position;
    attribute vec2 a_texCoord;
    varying vec2 v_texCoord;

    void main() {
        // Simple pass-through, mapping quad vertices to clip space
        gl_Position = vec4(a_position, 0.0, 1.0);
        // Pass texture coordinates to the fragment shader
        v_texCoord = a_texCoord;
    }
`;

export const fragmentShaderSource = `
    precision mediump float;
    varying vec2 v_texCoord;
    uniform sampler2D u_texture;
    uniform int u_channel; // 0=C, 1=M, 2=Y

    // Function to convert RGB to CMYK (approximation)
    vec4 rgbToCmyk(vec3 rgb) {
        float k = 1.0 - max(max(rgb.r, rgb.g), rgb.b);
        // Avoid division by zero if K is 1 (pure black)
        float invK = 1.0 / max(1.0 - k, 0.00001);
        float c = (1.0 - rgb.r - k) * invK;
        float m = (1.0 - rgb.g - k) * invK;
        float y = (1.0 - rgb.b - k) * invK;
        return vec4(c, m, y, k);
    }

    void main() {
        vec4 color = texture2D(u_texture, v_texCoord);
        vec3 rgb = color.rgb;

        // Convert RGB to CMYK
        vec4 cmyk = rgbToCmyk(rgb);

        // Select the channel based on the uniform
        float channelValue;
        if (u_channel == 0) { // Cyan
            channelValue = cmyk.x; // Use .x for C
        } else if (u_channel == 1) { // Magenta
            channelValue = cmyk.y; // Use .y for M
        } else { // Yellow (u_channel == 2)
            channelValue = cmyk.z; // Use .z for Y
        }
        // Note: We are ignoring the K (black) channel (cmyk.w or cmyk.a) for this visualization.

        // Output the selected channel value as grayscale
        gl_FragColor = vec4(vec3(channelValue), 1.0);
    }
`;
