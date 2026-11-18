package mq

import "time"

type PaySucceeded struct {
	OrderID int64
	PaidAt  time.Time
}
