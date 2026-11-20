(Surface Height Map Z compensation preview test - 50 x 50 mm XY area)
(Metric, absolute, G54; XY coordinates span 0-50 on both axes, matching a 50 x 50 mm map.)
(Spindle remains off. Constant nominal Z10 mm makes this an air-move preview test, not a cutting program.)
(Apply the saved map, then inspect the compensated copy for subdivided XY moves with changing Z values.)
G21 G90 G94 G54
M5
G0 X0 Y0
G0 Z10
(Serpentine raster; nominal Z stays at 10 mm throughout.)
G1 X50 Y0 Z10 F300
G1 X50 Y5 Z10
G1 X0 Y5 Z10
G1 X0 Y10 Z10
G1 X50 Y10 Z10
G1 X50 Y15 Z10
G1 X0 Y15 Z10
G1 X0 Y20 Z10
G1 X50 Y20 Z10
G1 X50 Y25 Z10
G1 X0 Y25 Z10
G1 X0 Y30 Z10
G1 X50 Y30 Z10
G1 X50 Y35 Z10
G1 X0 Y35 Z10
G1 X0 Y40 Z10
G1 X50 Y40 Z10
G1 X50 Y45 Z10
G1 X0 Y45 Z10
G1 X0 Y50 Z10
G1 X50 Y50 Z10
G0 Z10
M5
M30
