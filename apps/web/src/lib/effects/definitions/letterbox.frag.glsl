precision mediump float;

uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_amount;
uniform vec3 u_color;

varying vec2 v_texCoord;

void main() {
	float barSize = u_amount / 100.0;
	vec4 texColor = texture2D(u_texture, v_texCoord);

	if (v_texCoord.y < barSize || v_texCoord.y > 1.0 - barSize) {
		gl_FragColor = vec4(u_color, 1.0);
	} else {
		gl_FragColor = texColor;
	}
}
