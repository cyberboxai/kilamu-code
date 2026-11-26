from app.models.customer import Customer


class CustomerRepository:
    def __init__(self, session):
        self.session = session

    def get(self, customer_id: int) -> Customer | None:
        return self.session.query(Customer).filter(Customer.customer_id == customer_id).one_or_none()
