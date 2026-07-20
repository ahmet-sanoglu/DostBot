// ROS topic adlarının merkezi listesi — farklı bileşenler aynı kanal adını buradan alır.
// Topic: robot üzerindeki yazılımların birbirine mesaj gönderdiği isimlendirilmiş kanal.

/** Joystick ve PS4 kolunun hız komutlarının gittiği kanal; robot tarafında twist_mux birleştirir. */
export const CMD_VEL_JOY_TOPIC = '/cmd_vel/joy';
