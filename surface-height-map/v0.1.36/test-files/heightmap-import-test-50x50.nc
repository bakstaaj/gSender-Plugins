(Surface Height Map import test - 50 x 50 mm XY area)
(Metric, absolute, G54; XY coordinates span 0-50 on both axes, matching a 50 x 50 mm map.)
(Preview-only XY travel pattern. No Z moves or spindle start; do not run, use only to test map import and preview.)
G21
G90
G54

(Outer 50 mm square)
G0 X0 Y0
G0 X50 Y0
G0 X50 Y50
G0 X0 Y50
G0 X0 Y0
(Diagonal cross)
G0 X5 Y5
G0 X45 Y45
G0 X5 Y45
G0 X45 Y5
(Inner 30 mm square)
G0 X10 Y10
G0 X40 Y10
G0 X40 Y40
G0 X10 Y40
G0 X10 Y10
(Grid lines)
G0 X10 Y20
G0 X10 Y30
G0 X20 Y10
G0 X20 Y40
G0 X30 Y10
G0 X30 Y40
G0 X40 Y20
G0 X40 Y30
G0 X20 Y10
G0 X30 Y10
G0 X10 Y20
G0 X40 Y20
G0 X10 Y30
G0 X40 Y30
G0 X20 Y40
G0 X30 Y40
M5
M30

