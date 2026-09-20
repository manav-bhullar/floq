import { useState, useEffect, useRef, useId } from "react";
import { createPortal } from "react-dom";
import "./DateTimePicker.css";

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DAYS_OF_WEEK = ["S", "M", "T", "W", "T", "F", "S"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export default function DateTimePickerModal({
  isOpen,
  onClose,
  onConfirm,
  initialDate,
}) {
  const titleId = useId();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [selectedTime, setSelectedTime] = useState("12:00 AM");
  const [isTimeDropdownOpen, setIsTimeDropdownOpen] = useState(false);
  const timeDropdownRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (
        timeDropdownRef.current &&
        !timeDropdownRef.current.contains(event.target)
      ) {
        setIsTimeDropdownOpen(false);
      }
    };
    if (isTimeDropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isTimeDropdownOpen]);

  useEffect(() => {
    if (isOpen) {
      const d = initialDate ? new Date(initialDate) : new Date();
      // If initialDate is somehow in the past, use now
      if (d < new Date()) {
        d.setTime(Date.now());
      }
      setSelectedDate(d);
      setCurrentDate(d);

      const ms = 1000 * 60 * 15;
      const rounded = new Date(Math.ceil(d.getTime() / ms) * ms);

      let rh = rounded.getHours();
      const rm = rounded.getMinutes();
      const rampm = rh >= 12 ? "PM" : "AM";
      rh = rh % 12 || 12;

      setSelectedTime(
        `${rh.toString().padStart(2, "0")}:${rm.toString().padStart(2, "0")} ${rampm}`,
      );
    }
  }, [isOpen, initialDate]);

  if (!isOpen) return null;

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const daysInMonth =
    month === 1 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month];
  const firstDayOfMonth = new Date(year, month, 1).getDay();

  const handlePrevMonth = () => setCurrentDate(new Date(year, month - 1, 1));
  const handleNextMonth = () => setCurrentDate(new Date(year, month + 1, 1));

  const handleConfirm = () => {
    const finalDate = new Date(selectedDate);
    const [timeStr, ampmStr] = selectedTime.split(" ");
    const [hStr, mStr] = timeStr.split(":");
    let h = parseInt(hStr, 10);
    if (ampmStr === "PM" && h !== 12) h += 12;
    if (ampmStr === "AM" && h === 12) h = 0;
    finalDate.setHours(h);
    finalDate.setMinutes(parseInt(mStr, 10));
    finalDate.setSeconds(0);
    finalDate.setMilliseconds(0);

    // Create local ISO string
    const tzOffset = finalDate.getTimezoneOffset() * 60000;
    const localIso = new Date(finalDate.getTime() - tzOffset)
      .toISOString()
      .slice(0, 16);
    onConfirm(localIso);
  };

  const generateTimeOptions = () => {
    const options = [];
    const now = new Date();
    const isToday =
      selectedDate.getDate() === now.getDate() &&
      selectedDate.getMonth() === now.getMonth() &&
      selectedDate.getFullYear() === now.getFullYear();

    const currentTotalMins = now.getHours() * 60 + now.getMinutes();

    for (let i = 0; i < 24 * 4; i++) {
      const totalMins = i * 15;

      if (isToday && totalMins < currentTotalMins) {
        continue;
      }

      let h = Math.floor(totalMins / 60);
      const m = totalMins % 60;
      const ampm = h >= 12 ? "PM" : "AM";
      h = h % 12 || 12;
      const val = `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")} ${ampm}`;
      options.push(val);
    }

    // Fallback if all times have passed today (e.g. 11:55 PM)
    if (options.length === 0) {
      options.push("11:59 PM");
    }
    return options;
  };
  const timeOptions = generateTimeOptions();

  const renderCalendar = () => {
    const days = [];
    for (let i = 0; i < firstDayOfMonth; i++) {
      days.push(<div key={`empty-${i}`} className="calendar-day empty"></div>);
    }

    const now = new Date();

    for (let d = 1; d <= daysInMonth; d++) {
      const isSelected =
        selectedDate.getDate() === d &&
        selectedDate.getMonth() === month &&
        selectedDate.getFullYear() === year;
      const isToday =
        now.getDate() === d &&
        now.getMonth() === month &&
        now.getFullYear() === year;

      days.push(
        <button
          key={d}
          type="button"
          className={`calendar-day ${isSelected ? "selected" : ""} ${isToday && !isSelected ? "today" : ""}`}
          onClick={() => setSelectedDate(new Date(year, month, d))}
          aria-label={`${MONTH_NAMES[month]} ${d}, ${year}`}
          aria-selected={isSelected}
        >
          {d}
        </button>,
      );
    }
    return days;
  };

  return createPortal(
    <div className="modal-backdrop dt-backdrop" onClick={onClose}>
      <div
        className="modal expressive-calendar-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="calendar-header">
          <button
            type="button"
            className="icon-btn"
            onClick={handlePrevMonth}
            aria-label="Previous month"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="24px"
              viewBox="0 -960 960 960"
              width="24px"
              fill="currentColor"
            >
              <path d="M560-240 320-480l240-240 56 56-184 184 184 184-56 56Z" />
            </svg>
          </button>
          <h3 id={titleId}>
            {MONTH_NAMES[month]} {year}
          </h3>
          <button
            type="button"
            className="icon-btn"
            onClick={handleNextMonth}
            aria-label="Next month"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="24px"
              viewBox="0 -960 960 960"
              width="24px"
              fill="currentColor"
            >
              <path d="M504-480 320-664l56-56 240 240-240 240-56-56 184-184Z" />
            </svg>
          </button>
        </div>

        <div className="calendar-grid days-of-week">
          {DAYS_OF_WEEK.map((day, i) => (
            <div key={i}>{day}</div>
          ))}
        </div>

        <div className="calendar-grid">{renderCalendar()}</div>

        <div
          className="time-picker-section"
          style={{ display: "flex", justifyContent: "center" }}
        >
          <div className="m3-time-dropdown-container" ref={timeDropdownRef}>
            <button
              type="button"
              className="m3-time-select-btn"
              onClick={() => setIsTimeDropdownOpen(!isTimeDropdownOpen)}
              aria-label="Select time"
              aria-expanded={isTimeDropdownOpen}
            >
              <span>{selectedTime}</span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                height="24px"
                viewBox="0 -960 960 960"
                width="24px"
                fill="currentColor"
              >
                <path d="M480-360 280-560h400L480-360Z" />
              </svg>
            </button>
            {isTimeDropdownOpen && (
              <div className="m3-time-dropdown-menu">
                {timeOptions.map((t) => (
                  <button
                    type="button"
                    key={t}
                    className={`m3-time-dropdown-item ${t === selectedTime ? "selected" : ""}`}
                    onClick={() => {
                      setSelectedTime(t);
                      setIsTimeDropdownOpen(false);
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="modal-actions" style={{ marginTop: "24px" }}>
          <button type="button" className="btn btn-tonal" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleConfirm}
          >
            OK
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
